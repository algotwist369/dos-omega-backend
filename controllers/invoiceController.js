const mongoose = require('mongoose');
const Invoice = require('../models/invoiceModel');
const InvoiceFolder = require('../models/invoiceFolderModel');
const InvoicePermission = require('../models/invoicePermissionModel');
const s3Service = require('../services/s3.service');
const { logInvoiceActivity } = require('../services/invoiceAudit.service');
const { resolveFolderByIdOrPath, getAllDescendantFolderIds } = require('../utils/invoiceFolderHelper');

// 1. Batch Pre-signed URLs for up to 2000 files (Super fast, <15ms)
const batchPresignUpload = async (req, res) => {
    try {
        const { folderId, files } = req.body;

        if (!folderId) {
            return res.status(400).json({ error: 'Folder ID is required' });
        }

        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'Files array is required' });
        }

        const maxFilesLimit = parseInt(process.env.MAXIMUM_INVOICE_FILES, 10) || 2000;
        if (files.length > maxFilesLimit) {
            return res.status(400).json({ error: `Maximum ${maxFilesLimit} files can be uploaded at once` });
        }

        const presignedFiles = await s3Service.getBatchPresignedUploadUrls({
            folderId,
            files,
        });

        return res.json({
            folderId,
            files: presignedFiles,
        });
    } catch (err) {
        console.error('[Invoice] batchPresignUpload error:', err);
        return res.status(500).json({ error: 'Failed to generate pre-signed upload URLs' });
    }
};

// 2. Batch Confirmation of Uploaded Invoices into MongoDB
const confirmBatchUpload = async (req, res) => {
    try {
        const { folderId, uploadedFiles } = req.body;

        if (!folderId || !Array.isArray(uploadedFiles) || uploadedFiles.length === 0) {
            return res.status(400).json({ error: 'Invalid upload confirmation payload' });
        }

        const folder = await InvoiceFolder.findById(folderId);
        if (!folder) {
            return res.status(404).json({ error: 'Folder not found' });
        }

        const documents = uploadedFiles.map((file) => {
            const dateObj = file.invoiceDate ? new Date(file.invoiceDate) : new Date();
            const year = isNaN(dateObj.getFullYear()) ? new Date().getFullYear() : dateObj.getFullYear();
            const month = isNaN(dateObj.getMonth()) ? new Date().getMonth() + 1 : dateObj.getMonth() + 1;

            return {
                folder_id: file.folderId || folderId,
                file_name: file.fileName,
                stored_s3_key: file.s3Key,
                s3_bucket: file.bucket || s3Service.bucketName,
                file_size_bytes: file.fileSizeBytes || 0,
                original_size_bytes: file.originalSizeBytes || file.fileSizeBytes || 0,
                mime_type: file.mimeType || 'application/pdf',
                invoice_date: isNaN(dateObj.getTime()) ? new Date() : dateObj,
                year,
                month,
                category: (file.category || 'General').trim(),
                file_hash: file.fileHash || '',
                uploaded_by: {
                    user_id: req.user._id,
                    username: req.user.username || req.user.email,
                    email: req.user.email,
                    role: req.user.role,
                },
                is_deleted: false,
            };
        });

        const createdInvoices = await Invoice.insertMany(documents);

        logInvoiceActivity({
            action: 'INVOICE_UPLOADED',
            user: req.user,
            folderId: folder._id,
            folderName: folder.name,
            details: {
                count: createdInvoices.length,
                fileNames: createdInvoices.map(i => i.file_name).slice(0, 10),
            },
            ipAddress: req.ip,
        });

        return res.status(201).json({
            message: `Successfully uploaded and saved ${createdInvoices.length} invoices`,
            count: createdInvoices.length,
            invoices: createdInvoices,
        });
    } catch (err) {
        console.error('[Invoice] confirmBatchUpload error:', err);
        return res.status(500).json({ error: 'Failed to record uploaded invoices' });
    }
};

// 3. Get Active Invoices in Folder (or across folders for CA) with Category/Date/Month/Year filters
const getInvoices = async (req, res) => {
    try {
        const {
            folderId,
            year,
            month,
            startDate,
            endDate,
            search,
            category,
            page = 1,
            limit = 50,
        } = req.query;

        const filter = { is_deleted: false };

        if (folderId) {
            let actualFolderId = null;
            if (mongoose.Types.ObjectId.isValid(folderId) && /^[0-9a-fA-F]{24}$/.test(String(folderId).trim())) {
                actualFolderId = folderId;
            } else {
                const resolved = await resolveFolderByIdOrPath(folderId);
                if (resolved) actualFolderId = resolved._id;
            }

            if (!actualFolderId) {
                return res.json({
                    invoices: [],
                    total: 0,
                    categories: [],
                    page: 1,
                    totalPages: 0,
                });
            }

            if (req.query.includeSubfolders === 'true') {
                const descendantIds = await getAllDescendantFolderIds(actualFolderId);
                filter.folder_id = { $in: [actualFolderId, ...descendantIds] };
            } else {
                filter.folder_id = actualFolderId;
            }
        } else if (req.user?.role !== 'super_admin') {
            const perm = await InvoicePermission.findOne({ user_id: req.user._id });
            if (perm?.is_ca && perm.folder_access_type === 'custom') {
                const baseAllowedIds = (perm.allowed_folder_ids || []).map(id => id.toString());
                let allAccessibleIds = [...baseAllowedIds];
                for (const fId of baseAllowedIds) {
                    const descIds = await getAllDescendantFolderIds(fId);
                    allAccessibleIds.push(...descIds.map(d => d.toString()));
                }
                filter.folder_id = { $in: [...new Set(allAccessibleIds)] };
            } else if (!perm?.can_manage_invoices && !perm?.is_ca) {
                const baseFolders = await InvoiceFolder.find({
                    is_active: true,
                    $or: [
                        { 'created_by.user_id': req.user._id },
                        { 'assigned_users.user_id': req.user._id },
                    ],
                }).select('_id');
                let allAccessibleIds = baseFolders.map(f => f._id.toString());
                for (const fId of baseFolders.map(f => f._id)) {
                    const descIds = await getAllDescendantFolderIds(fId);
                    allAccessibleIds.push(...descIds.map(d => d.toString()));
                }
                filter.folder_id = { $in: [...new Set(allAccessibleIds)] };
            }
        }

        if (category && category !== 'all' && category.trim()) {
            filter.category = category.trim();
        }

        if (year) {
            filter.year = parseInt(year, 10);
        }

        if (month) {
            filter.month = parseInt(month, 10);
        }

        if (startDate || endDate) {
            filter.invoice_date = {};
            if (startDate) filter.invoice_date.$gte = new Date(startDate);
            if (endDate) filter.invoice_date.$lte = new Date(endDate);
        }

        if (search) {
            filter.file_name = { $regex: search.trim(), $options: 'i' };
        }

        const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
        const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10)));

        const [invoices, total, categories] = await Promise.all([
            Invoice.find(filter)
                .populate('folder_id', 'name')
                .sort({ invoice_date: -1, created_at: -1 })
                .skip(skip)
                .limit(pageSize),
            Invoice.countDocuments(filter),
            folderId
                ? Invoice.distinct('category', { folder_id: folderId, is_deleted: false })
                : Invoice.distinct('category', { is_deleted: false }),
        ]);

        return res.json({
            invoices,
            total,
            categories: categories.filter(Boolean),
            page: parseInt(page, 10),
            totalPages: Math.ceil(total / pageSize),
        });
    } catch (err) {
        console.error('[Invoice] getInvoices error:', err);
        return res.status(500).json({ error: 'Failed to fetch invoices' });
    }
};

// 4. Secure Presigned URL for in-browser Preview (PDF / Image)
const getInvoiceViewUrl = async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const invoice = await Invoice.findById(invoiceId);

        if (!invoice || invoice.is_deleted) {
            return res.status(404).json({ error: 'Invoice not found or archived' });
        }

        const viewUrl = await s3Service.getPresignedViewUrl(invoice.stored_s3_key);
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip || '';

        let folderName = '';
        if (invoice.folder_id) {
            const folder = await InvoiceFolder.findById(invoice.folder_id).select('name');
            if (folder) folderName = folder.name;
        }

        logInvoiceActivity({
            action: 'INVOICE_VIEWED',
            user: req.user,
            folderId: invoice.folder_id,
            folderName: folderName,
            invoiceId: invoice._id,
            invoiceName: invoice.file_name,
            details: { mimeType: invoice.mime_type, fileSize: invoice.file_size_bytes },
            ipAddress: clientIp,
        });

        return res.json({ viewUrl, fileName: invoice.file_name, mimeType: invoice.mime_type });
    } catch (err) {
        console.error('[Invoice] getInvoiceViewUrl error:', err);
        return res.status(500).json({ error: 'Failed to generate preview URL' });
    }
};

// 5. Secure Presigned URL for File Download
const getInvoiceDownloadUrl = async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const invoice = await Invoice.findById(invoiceId);

        if (!invoice || invoice.is_deleted) {
            return res.status(404).json({ error: 'Invoice not found or archived' });
        }

        const downloadUrl = await s3Service.getPresignedDownloadUrl(invoice.stored_s3_key, invoice.file_name);
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip || '';

        let folderName = '';
        if (invoice.folder_id) {
            const folder = await InvoiceFolder.findById(invoice.folder_id).select('name');
            if (folder) folderName = folder.name;
        }

        logInvoiceActivity({
            action: 'INVOICE_DOWNLOADED',
            user: req.user,
            folderId: invoice.folder_id,
            folderName: folderName,
            invoiceId: invoice._id,
            invoiceName: invoice.file_name,
            details: { fileSize: invoice.file_size_bytes },
            ipAddress: clientIp,
        });

        return res.json({ downloadUrl, fileName: invoice.file_name });
    } catch (err) {
        console.error('[Invoice] getInvoiceDownloadUrl error:', err);
        return res.status(500).json({ error: 'Failed to generate download URL' });
    }
};

// 6. Batch Download URLs for CA / Auditor (up to 200 files)
const getBatchDownloadUrls = async (req, res) => {
    try {
        const { invoiceIds } = req.body;

        if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
            return res.status(400).json({ error: 'invoiceIds array is required' });
        }

        const invoices = await Invoice.find({
            _id: { $in: invoiceIds },
            is_deleted: false,
        }).select('_id file_name stored_s3_key mime_type file_size_bytes folder_id');

        const downloadList = await Promise.all(
            invoices.map(async (inv) => {
                const downloadUrl = await s3Service.getPresignedDownloadUrl(inv.stored_s3_key, inv.file_name);
                return {
                    id: inv._id,
                    fileName: inv.file_name,
                    downloadUrl,
                    mimeType: inv.mime_type,
                    fileSize: inv.file_size_bytes,
                };
            })
        );

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip || '';

        logInvoiceActivity({
            action: 'INVOICES_BATCH_DOWNLOADED',
            user: req.user,
            details: { count: downloadList.length },
            ipAddress: clientIp,
        });

        return res.json({ files: downloadList });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to generate batch download URLs' });
    }
};

// 7. Soft Delete Invoice with MANDATORY REASON (Hidden from User & Admin; Sent to Archive Vault)
const softDeleteInvoice = async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const { reason } = req.body;

        if (!reason || reason.trim().length < 3) {
            return res.status(400).json({ error: 'A mandatory reason is required to delete this invoice' });
        }

        const invoice = await Invoice.findById(invoiceId).populate('folder_id');
        if (!invoice) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        if (invoice.is_deleted) {
            return res.status(400).json({ error: 'Invoice is already archived' });
        }

        // Authorization check: Super Admin, Folder Creator/Manager, or Uploader
        const userIdStr = req.user._id.toString();
        const isSuperAdmin = req.user.role === 'super_admin';
        const isUploader = invoice.uploaded_by?.user_id?.toString() === userIdStr;
        const isFolderOwner = invoice.folder_id?.created_by?.user_id?.toString() === userIdStr;

        if (!isSuperAdmin && !isUploader && !isFolderOwner) {
            return res.status(403).json({ error: 'You do not have permission to delete this invoice' });
        }

        invoice.is_deleted = true;
        invoice.deletion_meta = {
            deleted_by: {
                user_id: req.user._id,
                username: req.user.username || req.user.email,
                role: req.user.role,
            },
            deleted_at: new Date(),
            delete_reason: reason.trim(),
        };

        await invoice.save();

        logInvoiceActivity({
            action: 'INVOICE_DELETED',
            user: req.user,
            folderId: invoice.folder_id?._id,
            folderName: invoice.folder_id?.name || '',
            invoiceId: invoice._id,
            invoiceName: invoice.file_name,
            details: { reason: reason.trim() },
            ipAddress: req.ip,
        });

        return res.json({ message: 'Invoice deleted successfully' });
    } catch (err) {
        console.error('[Invoice] softDeleteInvoice error:', err);
        return res.status(500).json({ error: 'Failed to delete invoice' });
    }
};

// 7b. Batch Soft Delete Invoices with Mandatory Reason
const batchSoftDeleteInvoices = async (req, res) => {
    try {
        const { invoiceIds, reason } = req.body;

        if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
            return res.status(400).json({ error: 'invoiceIds array is required' });
        }

        if (!reason || reason.trim().length < 3) {
            return res.status(400).json({ error: 'A mandatory reason is required to delete selected invoices' });
        }

        const invoices = await Invoice.find({
            _id: { $in: invoiceIds },
            is_deleted: false,
        }).populate('folder_id');

        if (invoices.length === 0) {
            return res.status(404).json({ error: 'No active invoices found to delete' });
        }

        const userIdStr = req.user._id.toString();
        const isSuperAdmin = req.user.role === 'super_admin';

        let deletedCount = 0;
        for (const invoice of invoices) {
            const isUploader = invoice.uploaded_by?.user_id?.toString() === userIdStr;
            const isFolderOwner = invoice.folder_id?.created_by?.user_id?.toString() === userIdStr;

            if (isSuperAdmin || isUploader || isFolderOwner) {
                invoice.is_deleted = true;
                invoice.deletion_meta = {
                    deleted_by: {
                        user_id: req.user._id,
                        username: req.user.username || req.user.email,
                        role: req.user.role,
                    },
                    deleted_at: new Date(),
                    delete_reason: reason.trim(),
                };
                await invoice.save();
                deletedCount++;
            }
        }

        logInvoiceActivity({
            action: 'INVOICES_BATCH_DELETED',
            user: req.user,
            details: { count: deletedCount, reason: reason.trim() },
            ipAddress: req.ip,
        });

        return res.json({ message: `Successfully deleted ${deletedCount} invoices`, deletedCount });
    } catch (err) {
        console.error('[Invoice] batchSoftDeleteInvoices error:', err);
        return res.status(500).json({ error: 'Failed to batch delete invoices' });
    }
};

// 8. Super Admin Archive Vault (All Soft-Deleted Invoices + Reasons)
const getArchiveVault = async (req, res) => {
    try {
        const { search, page = 1, limit = 50 } = req.query;

        const filter = { is_deleted: true };

        if (search) {
            filter.$or = [
                { file_name: { $regex: search.trim(), $options: 'i' } },
                { 'deletion_meta.delete_reason': { $regex: search.trim(), $options: 'i' } },
                { 'deletion_meta.deleted_by.username': { $regex: search.trim(), $options: 'i' } },
            ];
        }

        const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
        const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10)));

        const [archivedInvoices, total] = await Promise.all([
            Invoice.find(filter)
                .populate('folder_id', 'name is_active')
                .sort({ 'deletion_meta.deleted_at': -1 })
                .skip(skip)
                .limit(pageSize),
            Invoice.countDocuments(filter),
        ]);

        return res.json({
            archivedInvoices,
            total,
            page: parseInt(page, 10),
            totalPages: Math.ceil(total / pageSize),
        });
    } catch (err) {
        console.error('[Invoice] getArchiveVault error:', err);
        return res.status(500).json({ error: 'Failed to fetch archive vault' });
    }
};

// 9. Restore Soft-Deleted Invoice (Super Admin only)
const restoreInvoice = async (req, res) => {
    try {
        const { invoiceId } = req.params;

        const invoice = await Invoice.findById(invoiceId).populate('folder_id');
        if (!invoice) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        if (!invoice.is_deleted) {
            return res.status(400).json({ error: 'Invoice is already active' });
        }

        const previousReason = invoice.deletion_meta?.delete_reason;
        invoice.is_deleted = false;
        invoice.deletion_meta = {
            deleted_by: null,
            deleted_at: null,
            delete_reason: '',
        };

        await invoice.save();

        logInvoiceActivity({
            action: 'INVOICE_RESTORED',
            user: req.user,
            folderId: invoice.folder_id?._id,
            folderName: invoice.folder_id?.name || '',
            invoiceId: invoice._id,
            invoiceName: invoice.file_name,
            details: { restoredFromReason: previousReason },
            ipAddress: req.ip,
        });

        return res.json({ message: 'Invoice restored successfully to active folder', invoice });
    } catch (err) {
        console.error('[Invoice] restoreInvoice error:', err);
        return res.status(500).json({ error: 'Failed to restore invoice' });
    }
};

// 10. Permanently Purge Invoice from S3 & Database (Super Admin only)
const purgeInvoicePermanently = async (req, res) => {
    try {
        const { invoiceId } = req.params;

        const invoice = await Invoice.findById(invoiceId).populate('folder_id');
        if (!invoice) {
            return res.status(404).json({ error: 'Invoice not found' });
        }

        // Delete from S3
        if (invoice.stored_s3_key) {
            await s3Service.deleteS3Object(invoice.stored_s3_key);
        }

        await Invoice.findByIdAndDelete(invoiceId);

        logInvoiceActivity({
            action: 'INVOICE_PURGED',
            user: req.user,
            folderId: invoice.folder_id?._id,
            folderName: invoice.folder_id?.name || '',
            invoiceId: invoice._id,
            invoiceName: invoice.file_name,
            details: { permanentlyDeletedKey: invoice.stored_s3_key },
            ipAddress: req.ip,
        });

        return res.json({ message: 'Invoice permanently purged from S3 and database' });
    } catch (err) {
        console.error('[Invoice] purgeInvoicePermanently error:', err);
        return res.status(500).json({ error: 'Failed to permanently delete invoice' });
    }
};

// 11. Check for Duplicate Invoices in a Folder
const checkDuplicates = async (req, res) => {
    try {
        const { folderId, files } = req.body;
        if (!folderId || !Array.isArray(files) || files.length === 0) {
            return res.json({ duplicates: [] });
        }

        const hashes = files.map(f => f.fileHash).filter(Boolean);
        const names = files.map(f => f.fileName).filter(Boolean);

        const orClauses = [];
        if (hashes.length > 0) {
            orClauses.push({ file_hash: { $in: hashes } });
        }
        if (names.length > 0) {
            orClauses.push({ file_name: { $in: names } });
        }

        if (orClauses.length === 0) {
            return res.json({ duplicates: [] });
        }

        const existingInvoices = await Invoice.find({
            folder_id: folderId,
            is_deleted: false,
            $or: orClauses,
        }).select('_id file_name file_size_bytes file_hash invoice_date uploaded_by category created_at');

        const duplicates = [];
        for (const file of files) {
            const match = existingInvoices.find(
                inv => (file.fileHash && inv.file_hash && inv.file_hash === file.fileHash) ||
                       (inv.file_name.toLowerCase() === (file.fileName || '').toLowerCase())
            );
            if (match) {
                duplicates.push({
                    fileName: file.fileName,
                    fileSizeBytes: file.fileSizeBytes,
                    fileHash: file.fileHash,
                    existingInvoice: {
                        _id: match._id,
                        fileName: match.file_name,
                        fileSizeBytes: match.file_size_bytes,
                        invoiceDate: match.invoice_date,
                        uploadedBy: match.uploaded_by?.username || match.uploaded_by?.email || 'Unknown',
                        category: match.category || 'General',
                        createdAt: match.created_at,
                    },
                    matchType: (file.fileHash && match.file_hash === file.fileHash) ? 'exact_hash' : 'name_match',
                });
            }
        }

        return res.json({ duplicates });
    } catch (err) {
        console.error('[Invoice] checkDuplicates error:', err);
        return res.status(500).json({ error: 'Failed to verify duplicate invoices' });
    }
};

// 12. Batch Purge Invoices Permanently from S3 & DB (Super Admin only)
const batchPurgeInvoices = async (req, res) => {
    try {
        const { invoiceIds } = req.body;

        if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
            return res.status(400).json({ error: 'invoiceIds array is required' });
        }

        const invoices = await Invoice.find({ _id: { $in: invoiceIds } });
        if (invoices.length === 0) {
            return res.status(404).json({ error: 'No invoices found to purge' });
        }

        // Delete all from S3
        await Promise.all(
            invoices.map(async (inv) => {
                if (inv.stored_s3_key) {
                    try {
                        await s3Service.deleteS3Object(inv.stored_s3_key);
                    } catch (e) {
                        console.error('[Invoice] Failed to delete S3 key:', inv.stored_s3_key, e.message);
                    }
                }
            })
        );

        await Invoice.deleteMany({ _id: { $in: invoiceIds } });

        logInvoiceActivity({
            action: 'INVOICES_BATCH_PURGED',
            user: req.user,
            details: {
                purgedCount: invoices.length,
                purgedInvoiceIds: invoiceIds,
            },
            ipAddress: req.ip,
        });

        return res.json({
            message: `Successfully purged ${invoices.length} invoices permanently from S3 and database`,
            purgedCount: invoices.length,
        });
    } catch (err) {
        console.error('[Invoice] batchPurgeInvoices error:', err);
        return res.status(500).json({ error: 'Failed to purge selected invoices' });
    }
};

// 13. Batch Restore Invoices back to Active Folders (Super Admin only)
const batchRestoreInvoices = async (req, res) => {
    try {
        const { invoiceIds } = req.body;

        if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
            return res.status(400).json({ error: 'invoiceIds array is required' });
        }

        const updateResult = await Invoice.updateMany(
            { _id: { $in: invoiceIds }, is_deleted: true },
            {
                $set: {
                    is_deleted: false,
                    deletion_meta: {
                        deleted_by: null,
                        deleted_at: null,
                        delete_reason: '',
                    },
                },
            }
        );

        logInvoiceActivity({
            action: 'INVOICES_BATCH_RESTORED',
            user: req.user,
            details: {
                restoredCount: updateResult.modifiedCount || 0,
            },
            ipAddress: req.ip,
        });

        return res.json({
            message: `Successfully restored ${updateResult.modifiedCount || 0} invoices back to their active folders`,
            restoredCount: updateResult.modifiedCount || 0,
        });
    } catch (err) {
        console.error('[Invoice] batchRestoreInvoices error:', err);
        return res.status(500).json({ error: 'Failed to restore selected invoices' });
    }
};

module.exports = {
    batchPresignUpload,
    confirmBatchUpload,
    checkDuplicates,
    getInvoices,
    getInvoiceViewUrl,
    getInvoiceDownloadUrl,
    getBatchDownloadUrls,
    softDeleteInvoice,
    batchSoftDeleteInvoices,
    getArchiveVault,
    restoreInvoice,
    batchRestoreInvoices,
    purgeInvoicePermanently,
    batchPurgeInvoices,
};
