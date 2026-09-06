
export function toMysqlDateTime(value) {
    if (value === null || value === undefined || value === "") return null;

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    const pad = (n) => String(n).padStart(2, "0");
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}
