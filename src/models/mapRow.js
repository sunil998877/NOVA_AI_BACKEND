export const mapRow = (row) => {
    if (!row) return null;

    const mapped = {
        ...row,
        _id: String(row.id),
    };

    if (row.user_id != null) mapped.user_id = String(row.user_id);
    if (row.campaign_id != null) mapped.campaign_id = String(row.campaign_id);
    if (row.conversation_id != null) mapped.conversation_id = String(row.conversation_id);

    return mapped;
};

export const mapRows = (rows) => rows.map(mapRow);

export const placeholders = (items) => items.map(() => "?").join(", ");
