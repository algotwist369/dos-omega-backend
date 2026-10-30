const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema(
    {
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        role_in_team: {
            type: String,
            enum: ['leader', 'member'],
            default: 'member',
        },
        // Granular locations/businesses assigned to this specific member within this sub-team
        assigned_businesses: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Business',
            },
        ],
        joined_at: {
            type: Date,
            default: Date.now,
        },
    },
    { _id: false }
);

const teamSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        description: {
            type: String,
            trim: true,
            default: '',
            maxlength: 500,
        },
        type: {
            type: String,
            enum: ['root', 'subteam'],
            default: 'root',
            index: true,
        },
        // NULL for root teams (e.g., "Social Media Team")
        // Points to parent Team for sub-teams (e.g., "Team A" -> "Social Media Team")
        parent_team_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Team',
            default: null,
            index: true,
        },
        // Sub-team designated leader
        leader_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },
        // Sub-team members and their respective assigned locations
        members: [teamMemberSchema],

        // Aggregated pool of all businesses/locations allocated to this sub-team
        business_ids: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Business',
                index: true,
            },
        ],

        is_active: {
            type: Boolean,
            default: true,
            index: true,
        },
        created_by: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

// High-Performance Query Indexes
teamSchema.index({ parent_team_id: 1, name: 1, is_active: 1 });
teamSchema.index({ is_active: 1, parent_team_id: 1, createdAt: -1 });
teamSchema.index({ 'members.user_id': 1 });
teamSchema.index({ leader_id: 1 });
teamSchema.index({ is_active: 1, type: 1 });

module.exports = mongoose.model('Team', teamSchema);
