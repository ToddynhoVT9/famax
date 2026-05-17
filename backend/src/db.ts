import mysql from "mysql2/promise";
import { config } from "./config.js";

export const pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  dateStrings: false,
  timezone: "Z",

  charset: "utf8mb4",
});

export async function pingDatabase(): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
    console.log(`✅ MySQL conectado em ${config.DB_HOST}:${config.DB_PORT}`);
  } finally {
    connection.release();
  }
}
