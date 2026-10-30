require('dotenv').config();
const cluster = require('cluster');
const os = require('os');
const process = require('process');

const numCPUs = os.cpus().length;

const useCluster = process.env.NODE_ENV === 'production' && process.env.ENABLE_CLUSTER === 'true';

if (cluster.isPrimary && useCluster) {
    console.log(`Primary process ${process.pid} is running`);
    console.log(`Forking ${numCPUs} workers...\n`);

    // Fork workers
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    // Restart worker if crashes
    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died. Restarting...`);
        cluster.fork();
    });

} else {
    // Worker Process
    const express = require('express');
    const mongoose = require('mongoose');
    const connectDB = require('./config/db');
    const { connectReviewDB } = require('./config/reviewDb');
    const { connectSupportDB } = require('./config/supportDb');
    const { connectTaskDB, taskConnection } = require('./config/taskDb');
    const { connectInvoiceDB } = require('./config/invoiceDb');
    const cors = require('cors');
    const helmet = require('helmet');
    const compression = require('compression');
    const morgan = require('morgan')
    const path = require('path');
    const fs = require('fs');
    const apiMonitoringMiddleware = require('./middlewares/apiMonitoring.middleware');

    const app = express();

    // ==========================
    // 🔒 Security Middlewares
    // ==========================
    const allowlist = process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
        : [
            'https://omega.d0s369.co.in',
            'https://www.omega.d0s369.co.in',
            'https://business-review-management-frontend.vercel.app',
            'http://localhost:5173',
            'https://dos-omega.vercel.app'
        ];

    app.use(cors({
        origin: function (origin, callback) {
            // Allow non-browser requests
            if (!origin) return callback(null, true);

            if (allowlist.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error(`CORS blocked for origin: ${origin}`));
            }
        },
        credentials: true,
    }));
    app.use(helmet());
    app.use(compression());
    app.use(morgan('dev'))
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));

    // API Monitoring Middleware
    app.use(apiMonitoringMiddleware);

    // Static downloads directory for desktop application builds
    const downloadsPath = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsPath)) {
        fs.mkdirSync(downloadsPath, { recursive: true });
    }
    app.use('/downloads', express.static(downloadsPath));


    // ==========================
    // 🗄 MongoDB Connection
    // ==========================
    connectDB();
    connectReviewDB().catch((error) => {
        console.error('Review MongoDB connection error:', error);
    });
    connectSupportDB().catch((error) => {
        console.error('Support MongoDB connection error:', error);
    });
    connectTaskDB().catch((error) => {
        console.error('Task MongoDB connection error:', error);
    });
    connectInvoiceDB().catch((error) => {
        console.error('Invoice MongoDB connection error:', error);
    });

    // Start cron jobs only on the first worker or if not in cluster mode to avoid duplicate runs
    if (!cluster.isWorker || (cluster.worker && cluster.worker.id === 1)) {
        const startBusinessNewStatusJob = require('./jobs/businessNewStatus.job');
        startBusinessNewStatusJob();
        
        const startMonitoringJob = require('./jobs/monitoring.job');
        startMonitoringJob();
    }

    // ==========================
    // 📦 Routes
    // ==========================
    app.use('/api/users', require('./routes/userRoute'));
    app.use('/api/super-admin', require('./routes/superAdminRoute'));
    app.use('/api/monitoring', require('./routes/monitoringRoute'));
    app.use('/api/business', require('./routes/businessRoute'));
    app.use('/api/reviews', require('./routes/reviewRoute'));
    app.use('/api/groups', require('./routes/groupRoute'));
    app.use('/api/ai-reviews', require('./routes/aiReviewRoute'));
    app.use('/api/gbp-updates', require('./routes/gbpUpdatesRoute'));
    app.use('/api/social-media', require('./routes/socialMediaRoute'));
    app.use('/api/canva', require('./routes/canvaRoute'));
    app.use('/api/js-team', require('./routes/jsTeamRoute'));
    app.use('/api/web-dev', require('./routes/webDevRoute'));
    app.use('/api/leads-management', require('./routes/leadsRoute'));
    app.use('/api/google-ads', require('./routes/googleAdsRoute'));
    app.use('/api/notifications', require('./routes/notificationRoute'));
    app.use('/api/support', require('./routes/supportRoute'));
    app.use('/api/chat', require('./routes/chatRoute'));
    app.use('/api/tasks', require('./routes/taskRoute'));
    app.use('/api/teams', require('./routes/teamRoute'));
    app.use('/api/invoice-permissions', require('./routes/invoicePermissionRoute'));
    app.use('/api/invoice-folders', require('./routes/invoiceFolderRoute'));
    app.use('/api/invoices', require('./routes/invoiceRoute'));
    app.use('/api/invoice-activity-logs', require('./routes/invoiceActivityLogRoute'));


    // ==========================
    // ❤️ Health Check
    // ==========================
    app.get('/health', (req, res) => {
        res.status(200).json({
            status: 'OK',
            pid: process.pid,
        });
    });


    // ==========================
    // ❌ Global Error Handler
    // ==========================
    app.use((err, req, res, next) => {
        console.error(err.stack);
        res.status(500).json({ error: 'Internal Server Error' });
    });


    // ==========================
    // 🚀 Start Server
    // ==========================
    const PORT = process.env.PORT || 7001;

    const server = app.listen(PORT, () => {
        console.log(`Worker ${process.pid} running on port ${PORT}`);
    });

    // TCP & WebSocket Socket Optimization for ultra-smooth low-latency communication
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.on('connection', (tcpSocket) => {
        tcpSocket.setNoDelay(true); // Disable Nagle's algorithm for instantaneous TCP packet delivery
        tcpSocket.setKeepAlive(true, 10000); // 10-second TCP keep-alive probe
    });

    const { initSocket } = require('./services/socketService');
    initSocket(server);


    // ==========================
    // 🛑 Graceful Shutdown
    // ==========================
    const shutdown = async () => {
        console.log(`Worker ${process.pid} shutting down...`);
        server.close(async () => {
            if (taskConnection.readyState === 1) await taskConnection.close();
            await mongoose.connection.close();
            process.exit(0);
        });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
