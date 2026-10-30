const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
const adminMiddleware = require('../middlewares/admin.middleware');
const {
    createTeam,
    getTeamsTree,
    getTeamById,
    updateTeam,
    deleteTeam,
    manageSubTeamMembers,
    assignBusinessesToMember,
    removeMemberFromSubTeam,
} = require('../controller/teamController');

// All team routes require authentication
router.use(authMiddleware);

// 1. Get Hierarchical Tree View (Accessible to authenticated users)
router.get('/tree', getTeamsTree);

// 2. Get Team Details by ID
router.get('/:id', getTeamById);

// 3. Create Team or Sub-Team (Admin & Super Admin)
router.post('/', adminMiddleware, createTeam);

// 4. Update Team Info (Admin & Super Admin)
router.put('/:id', adminMiddleware, updateTeam);

// 5. Delete Team (Cascades to sub-teams)
router.delete('/:id', adminMiddleware, deleteTeam);

// 6. Manage Sub-Team Members & Assign Team Leader
router.post('/:subTeamId/members', adminMiddleware, manageSubTeamMembers);

// 7. Assign Businesses (Locations) to a Member within Sub-team
router.put('/:subTeamId/members/:userId/businesses', adminMiddleware, assignBusinessesToMember);

// 8. Remove Member from Sub-Team
router.delete('/:subTeamId/members/:userId', adminMiddleware, removeMemberFromSubTeam);

module.exports = router;
