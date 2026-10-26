import { lookup, Resolver } from "dns/promises";
import mysql from "mysql2/promise";
import { env } from "./env.js";
import { runMigrations } from "./migrations.js";

const isIpv4 = (value) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || ""));

async function resolveMysqlHost(hostname) {
    if (!hostname || isIpv4(hostname)) {
        return { address: hostname, servername: hostname };
    }

    try {
        const { address } = await lookup(hostname, { family: 4 });
        return { address, servername: hostname };
    } catch (lookupError) {
        const resolver = new Resolver();
        resolver.setServers(["8.8.8.8", "1.1.1.1"]);
        const addresses = await resolver.resolve4(hostname);
        if (!addresses[0]) {
            const error = new Error(`Could not resolve MySQL host '${hostname}'`);
            error.code = lookupError.code || "ENOTFOUND";
            throw error;
        }
        console.warn(
            `[MySQL] System DNS failed for ${hostname} (${lookupError.code || lookupError.message}). Connecting via ${addresses[0]}.`
        );
        return { address: addresses[0], servername: hostname };
    }
}

function shouldUseSsl(hostname) {
    if (process.env.MYSQL_SSL === "false" || process.env.MYSQL_SSL === "0") return false;
    if (process.env.MYSQL_SSL === "true" || process.env.MYSQL_SSL === "1") return true;
    return /\.aivencloud\.com$/i.test(String(hostname || ""));
}

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

export const closeDb = async () => {
    if (!pool) return;
    const current = pool;
    pool = null;
    await current.end();
};

export const connectDb = async () => {
    const { host, port, user, password, database } = env.mysql;

    try {
        const resolved = await resolveMysqlHost(host);

        if (resolved.address === "127.0.0.1" || host === "localhost") {
            try {
                const bootstrap = await mysql.createConnection({ host: resolved.address, port, user, password });
                await bootstrap.query(
                    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
                );
                await bootstrap.end();
            } catch (error) {
                console.warn("Could not create local database:", error.message);
            }
        }

        const poolConfig = {
            host: resolved.address,
            port,
            user,
            password,
            database,
            timezone: "Z",
            waitForConnections: true,
            connectionLimit: 20,
            queueLimit: 0,
            idleTimeout: 60000,
            connectTimeout: 20000,
        };

        if (shouldUseSsl(host)) {
            poolConfig.ssl = {
                rejectUnauthorized: false,
                servername: resolved.servername,
            };
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
                "• Check MYSQL_HOST in Backend/.env.\n" +
                "• Aiven hosts look like *.aivencloud.com and need a reachable public DNS.\n" +
                "• Railway internal hosts (mysql.railway.internal) only resolve inside Railway.\n"
            );
        }
        setTimeout(() => {
            console.log("Retrying database connection in 5s...");
            connectDb().catch(() => {});
        }, 5000);
    }
};

export default connectDb;
