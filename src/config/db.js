import mysql from "mysql2/promise";
import { env } from "./env.js";
import { tableStatements } from "../schema/index.js";

let pool;

export const getPool = () => {
    if (!pool) {
        throw new Error("MySQL pool is not initialized. Call connectDb() first.");
    }
    return pool;
};

export const query = async (sql, params = []) => {
    const [rows] = await getPool().execute(sql, params);
    return rows;
};

export const execute = async (sql, params = []) => {
    const [result] = await getPool().execute(sql, params);
    return result;
};

async function migrateCampaignCopyColumns(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns'
               AND COLUMN_NAME IN ('subject', 'body', 'total_recipients', 'sent_count', 'failed_count')`
        );
        const existing = new Set(rows.map((row) => row.COLUMN_NAME));
        if (!existing.has("subject")) {
            await pool.query(
                `ALTER TABLE campaigns ADD COLUMN subject VARCHAR(255) NULL AFTER status`
            );
        }
        if (!existing.has("body")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN body MEDIUMTEXT NULL AFTER subject`);
        }
        if (!existing.has("total_recipients")) {
            await pool.query(
                `ALTER TABLE campaigns ADD COLUMN total_recipients INT NOT NULL DEFAULT 0 AFTER body`
            );
        }
        if (!existing.has("sent_count")) {
            await pool.query(
                `ALTER TABLE campaigns ADD COLUMN sent_count INT NOT NULL DEFAULT 0 AFTER total_recipients`
            );
        }
        if (!existing.has("failed_count")) {
            await pool.query(
                `ALTER TABLE campaigns ADD COLUMN failed_count INT NOT NULL DEFAULT 0 AFTER sent_count`
            );
        }
    } catch (error) {
        console.error("Could not migrate campaigns columns:", error.message);
    }
}

async function migrateMailDeliveryStatus(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mails' AND COLUMN_NAME = 'delivery_status'`
        );
        if (!rows.length) {
            await pool.query(
                `ALTER TABLE mails ADD COLUMN delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending' AFTER status`
            );
        }
    } catch (error) {
        console.error("Could not migrate mails delivery_status column:", error.message);
    }
}

async function migrateTrackingColumns(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mails'
               AND COLUMN_NAME IN ('click_count', 'first_opened_at', 'last_opened_at')`
        );
        const existing = new Set(rows.map((row) => row.COLUMN_NAME));
        if (!existing.has("click_count")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN click_count INT NOT NULL DEFAULT 0 AFTER open_count`);
        }
        if (!existing.has("first_opened_at")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN first_opened_at DATETIME NULL AFTER click_count`);
        }
        if (!existing.has("last_opened_at")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN last_opened_at DATETIME NULL AFTER first_opened_at`);
        }
    } catch (error) {
        console.error("Could not migrate mails tracking columns:", error.message);
    }
}

async function cleanIndependentOrganization(pool) {
    try {
        await pool.query(
            `UPDATE users SET organization = '' WHERE LOWER(TRIM(organization)) = 'independent'`
        );
    } catch (error) {
        console.error("Could not clean up independent organization:", error.message);
    }
}

export const connectDb = async () => {
    const { host, port, user, password, database } = env.mysql;

    try {
        try {
            const bootstrap = await mysql.createConnection({ host, port, user, password });
            await bootstrap.query(
                `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
            await bootstrap.end();
        } catch (error) {
            console.error("Could not create database:", error.message);
        }

        pool = mysql.createPool({
            host,
            port,
            user,
            password,
            database,
            waitForConnections: true,
            connectionLimit: 10,
        });

        for (const statement of tableStatements) {
            await pool.query(statement);
        }

        await migrateCampaignCopyColumns(pool);
        await migrateMailDeliveryStatus(pool);
        await migrateTrackingColumns(pool);
        await cleanIndependentOrganization(pool);

        console.log(`Connected to MySQL successfully (${database})`);
        return pool;
    } catch (error) {
        console.error("Error connecting to MySQL:", error.message);
        if (error.code === "ER_ACCESS_DENIED_ERROR") {
            console.error(
                "Set MYSQL_USER and MYSQL_PASSWORD in Backend/.env to your local MySQL credentials (Workbench uses the same root password)."
            );
        }
        process.exit(1);
    }
};

export default connectDb;
