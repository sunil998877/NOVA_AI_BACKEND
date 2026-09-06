import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { mapRow, mapRows, placeholders } from "../src/models/mapRow.js";
import { toMysqlDateTime } from "../src/utils/datetime.js";
import { fetchWithTimeout } from "../src/utils/fetch.js";

test("mapRow stringifies ids and adds _id", () => {
    const row = mapRow({ id: 7, user_id: 12, campaign_id: 3, email: "a@b.com" });
    assert.equal(row._id, "7");
    assert.equal(row.user_id, "12");
    assert.equal(row.campaign_id, "3");
    assert.equal(row.email, "a@b.com");
});

test("mapRow returns null for empty input", () => {
    assert.equal(mapRow(null), null);
    assert.equal(mapRow(undefined), null);
});

test("mapRow leaves unrelated numeric fields untouched", () => {
    const row = mapRow({ id: 1, open_count: 5 });
    assert.equal(row.open_count, 5);
});

test("mapRows maps every row", () => {
    const rows = mapRows([{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.deepEqual(
        rows.map((r) => r._id),
        ["1", "2", "3"]
    );
});

test("placeholders builds parameter list", () => {
    assert.equal(placeholders([1, 2, 3]), "?, ?, ?");
    assert.equal(placeholders([]), "");
});

test("toMysqlDateTime formats dates in MySQL format", () => {
    const date = new Date(2024, 0, 5, 9, 8, 7);
    assert.equal(toMysqlDateTime(date), "2024-01-05 09:08:07");
});

test("toMysqlDateTime accepts strings and ISO input", () => {
    const out = toMysqlDateTime("2024-06-15T12:30:45Z");
    assert.match(out, /^2024-06-15 \d{2}:\d{2}:45$/);
});

test("toMysqlDateTime returns null for empty or invalid values", () => {
    assert.equal(toMysqlDateTime(null), null);
    assert.equal(toMysqlDateTime(""), null);
    assert.equal(toMysqlDateTime("not-a-date"), null);
});

test("fetchWithTimeout aborts when the server exceeds the timeout", async () => {
    const server = http.createServer(() => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const url = `http://127.0.0.1:${port}/slow`;
    await assert.rejects(() => fetchWithTimeout(url, {}, 100), (error) => {
        return error.name === "AbortError" || error.code === "UND_ERR_ABORTED";
    });

    server.close();
});

test("fetchWithTimeout resolves when the server responds in time", async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/fast`, {}, 2000);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);

    server.close();
});
