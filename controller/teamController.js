const Team = require('../model/Team');
const User = require('../model/user');
const Business = require('../model/Business');
const mongoose = require('mongoose');

// ==========================================
// 1. Create a Team (Root or Sub-team)
// ==========================================
exports.createTeam = async (req, res) => {
    try {
        const { name, description = '', type = 'root', parent_team_id = null, leader_id = null } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Team name is required' });
        }

        const trimmedName = name.trim();

        // If creating a sub-team, validate parent
        if (type === 'subteam') {
            if (!parent_team_id) {
                return res.status(400).json({ error: 'parent_team_id is required for a sub-team' });
            }

            const parentTeam = await Team.findOne({ _id: parent_team_id, is_active: true });
            if (!parentTeam) {
                return res.status(404).json({ error: 'Parent team not found or is inactive' });
            }
        }

        // Prevent duplicate names under the same parent
        const existing = await Team.findOne({
            name: trimmedName,
            parent_team_id: type === 'subteam' ? parent_team_id : null,
            is_active: true,
        });

        if (existing) {
            return res.status(400).json({
                error: `A team with name "${trimmedName}" already exists in this scope`,
            });
        }

        // Validate leader if provided
        if (leader_id) {
            const leaderUser = await User.findOne({ _id: leader_id, is_active: true, is_deleted: false });
            if (!leaderUser) {
                return res.status(404).json({ error: 'Designated team leader does not exist or is inactive' });
            }
        }

        const newTeam = new Team({
            name: trimmedName,
            description: description.trim(),
            type,
            parent_team_id: type === 'subteam' ? parent_team_id : null,
            leader_id: leader_id || null,
            created_by: req.user._id,
        });

        // If leader is assigned, automatically add them to members
        if (leader_id) {
            newTeam.members.push({
                user_id: leader_id,
                role_in_team: 'leader',
                assigned_businesses: [],
                joined_at: new Date(),
            });
        }

        await newTeam.save();

        const populatedTeam = await Team.findById(newTeam._id)
            .populate('leader_id', 'username email role')
            .populate('parent_team_id', 'name')
            .populate('created_by', 'username email');

        return res.status(201).json({
            message: `${type === 'root' ? 'Main team' : 'Sub-team'} created successfully`,
            team: populatedTeam,
        });
    } catch (error) {
        console.error('Error creating team:', error);
        return res.status(500).json({ error: error.message || 'Internal server error while creating team' });
    }
};

// ==========================================
// 2. Get Hierarchical Teams Tree (High-Speed)
// ==========================================
exports.getTeamsTree = async (req, res) => {
    try {
        const { search = '' } = req.query;

        // Fetch all active root and sub-teams in parallel
        const filter = { is_active: true };

        const allTeams = await Team.find(filter)
            .populate('leader_id', 'username email role')
            .populate('created_by', 'username email')
            .populate({
                path: 'members.user_id',
                select: 'username email role assigned_businesses',
                populate: {
                    path: 'assigned_businesses',
                    select: 'business_name location short_code',
                },
            })
            .populate('members.assigned_businesses', 'business_name location short_code')
            .populate('business_ids', 'business_name location short_code')
            .sort({ createdAt: -1 })
            .lean();

        // Separate root teams and sub-teams
        const rootTeams = [];
        const subTeamsMap = new Map();

        for (const team of allTeams) {
            if (!team.parent_team_id) {
                rootTeams.push({
                    ...team,
                    subteams: [],
                    totalMembersCount: 0,
                    totalBusinessesCount: 0,
                });
            } else {
                const parentId = team.parent_team_id.toString();
                if (!subTeamsMap.has(parentId)) {
                    subTeamsMap.set(parentId, []);
                }
                subTeamsMap.get(parentId).push(team);
            }
        }

        // Nest sub-teams into parent root teams
        for (const root of rootTeams) {
            const rootId = root._id.toString();
            const children = subTeamsMap.get(rootId) || [];
            root.subteams = children;

            // Compute aggregate rollups
            const uniqueUserIds = new Set();
            const uniqueBizIds = new Set();

            for (const sub of children) {
                if (sub.leader_id) uniqueUserIds.add(sub.leader_id._id.toString());
                (sub.members || []).forEach((m) => {
                    if (m.user_id) {
                        uniqueUserIds.add(m.user_id._id.toString());
                        // If member has no direct sub-team overrides, inherit from User's pre-assigned locations
                        if (!m.assigned_businesses || m.assigned_businesses.length === 0) {
                            if (m.user_id.assigned_businesses && m.user_id.assigned_businesses.length > 0) {
                                m.assigned_businesses = m.user_id.assigned_businesses;
                            }
                        }
                    }
                    const effectiveBiz = m.assigned_businesses || [];
                    effectiveBiz.forEach((b) => uniqueBizIds.add((b._id || b).toString()));
                });
                (sub.business_ids || []).forEach((b) => uniqueBizIds.add(b._id.toString()));
            }

            root.totalMembersCount = uniqueUserIds.size;
            root.totalBusinessesCount = uniqueBizIds.size;
        }

        // Optional search filtering by team or member name
        let result = rootTeams;
        if (search.trim()) {
            const term = search.trim().toLowerCase();
            result = rootTeams.filter((root) => {
                const matchRootName = root.name.toLowerCase().includes(term);
                const matchSub = (root.subteams || []).some(
                    (sub) =>
                        sub.name.toLowerCase().includes(term) ||
                        (sub.leader_id?.username && sub.leader_id.username.toLowerCase().includes(term)) ||
                        (sub.leader_id?.email && sub.leader_id.email.toLowerCase().includes(term)) ||
                        (sub.members || []).some(
                            (m) =>
                                (m.user_id?.username && m.user_id.username.toLowerCase().includes(term)) ||
                                (m.user_id?.email && m.user_id.email.toLowerCase().includes(term))
                        )
                );
                return matchRootName || matchSub;
            });
        }

        return res.status(200).json({
            success: true,
            totalRootTeams: result.length,
            data: result,
        });
    } catch (error) {
        console.error('Error fetching teams tree:', error);
        return res.status(500).json({ error: 'Internal server error while fetching teams hierarchy' });
    }
};

// ==========================================
// 3. Get Team Details by ID
// ==========================================
exports.getTeamById = async (req, res) => {
    try {
        const { id } = req.params;
        const team = await Team.findOne({ _id: id, is_active: true })
            .populate('leader_id', 'username email role')
            .populate('parent_team_id', 'name')
            .populate('created_by', 'username email')
            .populate({
                path: 'members.user_id',
                select: 'username email role assigned_businesses',
                populate: {
                    path: 'assigned_businesses',
                    select: 'business_name location short_code',
                },
            })
            .populate('members.assigned_businesses', 'business_name location short_code')
            .populate('business_ids', 'business_name location short_code');

        if (!team) {
            return res.status(404).json({ error: 'Team not found' });
        }

        return res.status(200).json({ success: true, data: team });
    } catch (error) {
        console.error('Error getting team by id:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

// ==========================================
// 4. Update Team Info (Name, Description)
// ==========================================
exports.updateTeam = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description } = req.body;

        const team = await Team.findOne({ _id: id, is_active: true });
        if (!team) {
            return res.status(404).json({ error: 'Team not found' });
        }

        if (name && name.trim()) {
            const trimmedName = name.trim();
            // Check for collision under same parent
            const duplicate = await Team.findOne({
                _id: { $ne: id },
                parent_team_id: team.parent_team_id,
                name: trimmedName,
                is_active: true,
            });
            if (duplicate) {
                return res.status(400).json({ error: `A team named "${trimmedName}" already exists in this scope` });
            }
            team.name = trimmedName;
        }

        if (typeof description === 'string') {
            team.description = description.trim();
        }

        await team.save();

        return res.status(200).json({
            message: 'Team updated successfully',
            data: team,
        });
    } catch (error) {
        console.error('Error updating team:', error);
        return res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

// ==========================================
// 5. Soft-Delete Team (Cascades to Sub-teams)
// ==========================================
exports.deleteTeam = async (req, res) => {
    try {
        const { id } = req.params;

        const team = await Team.findById(id);
        if (!team) {
            return res.status(404).json({ error: 'Team not found' });
        }

        team.is_active = false;
        await team.save();

        // If root team, also deactivate all sub-teams
        if (team.type === 'root') {
            await Team.updateMany({ parent_team_id: id }, { $set: { is_active: false } });
        }

        return res.status(200).json({ message: 'Team and related sub-teams deleted successfully' });
    } catch (error) {
        console.error('Error deleting team:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

// ==========================================
// 6. Manage Sub-Team Members & Team Leader
// ==========================================
exports.manageSubTeamMembers = async (req, res) => {
    try {
        const { subTeamId } = req.params;
        const { members = [], leader_id = null } = req.body;

        const subTeam = await Team.findOne({ _id: subTeamId, type: 'subteam', is_active: true });
        if (!subTeam) {
            return res.status(404).json({ error: 'Sub-team not found or is inactive' });
        }

        // Map existing member assigned businesses from subteam
        const existingBizMap = new Map();
        (subTeam.members || []).forEach((m) => {
            const uid = m.user_id.toString();
            existingBizMap.set(uid, (m.assigned_businesses || []).map((b) => b.toString()));
        });

        // Collect all user IDs involved
        const allUserIds = members.map((m) => (m.user_id?._id || m.user_id || '').toString()).filter(Boolean);
        if (leader_id) allUserIds.push(leader_id.toString());

        // Fetch pre-assigned businesses from User collection (reusing existing assignments!)
        const usersDocs = await User.find({ _id: { $in: allUserIds } }).select('_id assigned_businesses').lean();
        const userPreAssignedMap = new Map();
        usersDocs.forEach((u) => {
            userPreAssignedMap.set(u._id.toString(), (u.assigned_businesses || []).map((b) => b.toString()));
        });

        // Deduplicate user ids
        const newMembersList = [];
        const seenUsers = new Set();
        const allSubBizPool = new Set((subTeam.business_ids || []).map((b) => b.toString()));

        for (const item of members) {
            const uidStr = (item.user_id?._id || item.user_id || '').toString();
            if (!uidStr || seenUsers.has(uidStr)) continue;
            seenUsers.add(uidStr);

            const isLeader = leader_id && leader_id.toString() === uidStr;
            const roleInTeam = isLeader ? 'leader' : item.role_in_team || 'member';

            // If team already had businesses for this member, keep them; otherwise, pull their pre-assigned locations from User!
            const fromExisting = existingBizMap.get(uidStr);
            const fromUser = userPreAssignedMap.get(uidStr) || [];
            const effectiveBiz = (fromExisting && fromExisting.length > 0) ? fromExisting : fromUser;

            effectiveBiz.forEach((bId) => allSubBizPool.add(bId.toString()));

            newMembersList.push({
                user_id: uidStr,
                role_in_team: roleInTeam,
                assigned_businesses: effectiveBiz,
                joined_at: new Date(),
            });
        }

        // If leader_id is set but wasn't in members array, push leader
        if (leader_id && !seenUsers.has(leader_id.toString())) {
            const leaderUidStr = leader_id.toString();
            const fromExisting = existingBizMap.get(leaderUidStr);
            const fromUser = userPreAssignedMap.get(leaderUidStr) || [];
            const effectiveBiz = (fromExisting && fromExisting.length > 0) ? fromExisting : fromUser;

            effectiveBiz.forEach((bId) => allSubBizPool.add(bId.toString()));

            newMembersList.push({
                user_id: leaderUidStr,
                role_in_team: 'leader',
                assigned_businesses: effectiveBiz,
                joined_at: new Date(),
            });
        }

        subTeam.members = newMembersList;
        subTeam.leader_id = leader_id || null;
        subTeam.business_ids = Array.from(allSubBizPool);

        await subTeam.save();

        const populated = await Team.findById(subTeamId)
            .populate('leader_id', 'username email role')
            .populate({
                path: 'members.user_id',
                select: 'username email role assigned_businesses',
                populate: {
                    path: 'assigned_businesses',
                    select: 'business_name location short_code',
                },
            })
            .populate('members.assigned_businesses', 'business_name location short_code')
            .populate('business_ids', 'business_name location short_code');

        return res.status(200).json({
            message: 'Sub-team members and leader updated successfully',
            data: populated,
        });
    } catch (error) {
        console.error('Error updating subteam members:', error);
        return res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

// ==========================================
// 7. Assign Businesses (Locations) to a Member
// ==========================================
exports.assignBusinessesToMember = async (req, res) => {
    try {
        const { subTeamId, userId } = req.params;
        const { business_ids = [] } = req.body;

        const subTeam = await Team.findOne({ _id: subTeamId, type: 'subteam', is_active: true });
        if (!subTeam) {
            return res.status(404).json({ error: 'Sub-team not found' });
        }

        // Check if user is a member of this subteam
        const memberIndex = subTeam.members.findIndex((m) => m.user_id.toString() === userId.toString());
        if (memberIndex === -1) {
            return res.status(404).json({ error: 'User is not a member of this sub-team' });
        }

        // Convert to valid ObjectId strings
        const validBizIds = business_ids.map((id) => (id._id || id).toString());

        // 1. Update sub-team member assigned businesses
        subTeam.members[memberIndex].assigned_businesses = validBizIds;

        // 2. Ensure all these businesses are in the sub-team's aggregated business_ids pool
        const existingPool = new Set((subTeam.business_ids || []).map((id) => id.toString()));
        validBizIds.forEach((bId) => existingPool.add(bId));
        subTeam.business_ids = Array.from(existingPool);

        await subTeam.save();

        // 3. Update User's assigned_businesses (Exact single source of truth sync)
        await User.findByIdAndUpdate(userId, {
            $set: { assigned_businesses: validBizIds },
        });

        const populated = await Team.findById(subTeamId)
            .populate('leader_id', 'username email role')
            .populate({
                path: 'members.user_id',
                select: 'username email role assigned_businesses',
                populate: {
                    path: 'assigned_businesses',
                    select: 'business_name location short_code',
                },
            })
            .populate('members.assigned_businesses', 'business_name location short_code')
            .populate('business_ids', 'business_name location short_code');

        return res.status(200).json({
            message: 'Locations assigned to team member successfully and synced',
            data: populated,
        });
    } catch (error) {
        console.error('Error assigning businesses to member:', error);
        return res.status(500).json({ error: error.message || 'Internal server error' });
    }
};

// ==========================================
// 8. Remove Member from Sub-team
// ==========================================
exports.removeMemberFromSubTeam = async (req, res) => {
    try {
        const { subTeamId, userId } = req.params;

        const subTeam = await Team.findOne({ _id: subTeamId, type: 'subteam', is_active: true });
        if (!subTeam) {
            return res.status(404).json({ error: 'Sub-team not found' });
        }

        subTeam.members = subTeam.members.filter((m) => m.user_id.toString() !== userId.toString());

        // If the removed member was the leader, reset leader_id
        if (subTeam.leader_id && subTeam.leader_id.toString() === userId.toString()) {
            subTeam.leader_id = null;
        }

        await subTeam.save();

        return res.status(200).json({
            message: 'Member removed from sub-team successfully',
            data: subTeam,
        });
    } catch (error) {
        console.error('Error removing member:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
