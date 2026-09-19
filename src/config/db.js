import mysql from "mysql2/promise";
import { env } from "./env.js";
import { runMigrations } from "./migrations.js";

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

export const connectDb = async () => {
    const { host, port, user, password, database } = env.mysql;

    try {
        // Only run CREATE DATABASE bootstrap for local MySQL
        if (host === "127.0.0.1" || host === "localhost") {
            try {
                const bootstrap = await mysql.createConnection({ host, port, user, password });
                await bootstrap.query(
                    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
                );
                await bootstrap.end();
            } catch (error) {
                console.warn("Could not create local database:", error.message);
            }
        }

        const poolConfig = {
            host,
            port,
            user,
            password,
            database,
            waitForConnections: true,
            connectionLimit: 10,
            connectTimeout: 20000,
        };

        if (process.env.MYSQL_SSL === "true") {
            poolConfig.ssl = { rejectUnauthorized: false };
        }

        pool = mysql.createPool(poolConfig);

        await pool.query("SELECT 1");
        console.log(`Connected to MySQL successfully (${database} @ ${host}:${port})`);

        await runMigrations(pool);

        return pool;
    } catch (error) {
        console.error("Error connecting to MySQL:", error.message);
        if (error.code === "ER_ACCESS_DENIED_ERROR") {
            console.error(
                "Access denied: Verify MYSQL_USER and MYSQL_PASSWORD in Backend/.env."
            );
        } else if (error.code === "ENOTFOUND" || error.code === "EAI_FAIL") {
            console.error(
                `\n[MySQL Connection Guide]: Could not resolve host '${host}'.\n` +
                "• 'mysql.railway.internal' only resolves INSIDE Railway containers (not on local machines).\n" +
                "• For local development, go to Railway Dashboard -> MySQL -> Settings -> Public Networking (TCP Proxy).\n" +
                "• Copy the public domain (e.g. *.proxy.rlwy.net) and public port, or copy MYSQL_PUBLIC_URL.\n"
            );
        }
        // Do not crash the entire server; allow HTTP and health checks to stay alive while retrying
        setTimeout(() => {
            console.log("Retrying database connection in 5s...");
            connectDb().catch(() => {});
        }, 5000);
    }
};

export default connectDb;
