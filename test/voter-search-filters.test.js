import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPaginationMeta,
  buildVoterFilterClause,
  parsePaginationParams,
  VOTER_DEFAULT_ORDER_SQL,
} from "../src/voterSearchFilters.js";

test("/user/voters/search: filter-only supports camelCase aliases", () => {
  const { where, values } = buildVoterFilterClause({
    voterId: "ABC123",
    relationName: "Khan",
    partNumber: "21",
    houseNumber: "55",
    serialNumber: "900",
    minAge: "25",
    maxAge: "60",
    name: "Rahim",
    section: "North",
    assembly: "Test Assembly",
    gender: "Male",
    religion: "Muslim",
  });

  assert.ok(where.some((entry) => entry.startsWith("voter_id = $")));
  assert.ok(
    where.some((entry) => entry.startsWith("LOWER(relation_name) LIKE $")),
  );
  assert.ok(where.some((entry) => entry.startsWith("part_number = $")));
  assert.ok(where.some((entry) => entry.startsWith("house_number = $")));
  assert.ok(where.some((entry) => entry.startsWith("serial_number = $")));
  assert.ok(where.some((entry) => entry.startsWith("age >= $")));
  assert.ok(where.some((entry) => entry.startsWith("age <= $")));
  assert.ok(values.includes("ABC123"));
  assert.ok(values.includes("%khan%"));
  assert.ok(values.includes("21"));
  assert.ok(values.includes(25));
  assert.ok(values.includes(60));
});

test("/user/voters/search: filter-only supports snake_case aliases", () => {
  const { where, values } = buildVoterFilterClause({
    voter_id: "XYZ999",
    relation_name: "Das",
    booth_no: "34",
    house_number: "H-1",
    serial_number: "12",
    min_age: "18",
    max_age: "44",
  });

  assert.ok(where.includes("voter_id = $1"));
  assert.ok(where.includes("LOWER(relation_name) LIKE $2"));
  assert.ok(where.includes("part_number = $3"));
  assert.ok(where.includes("house_number = $4"));
  assert.ok(where.includes("serial_number = $5"));
  assert.ok(where.includes("age >= $6"));
  assert.ok(where.includes("age <= $7"));
  assert.deepEqual(values.slice(0, 5), ["XYZ999", "%das%", "34", "H-1", "12"]);
});

test("/user/voters/search: pagination-only parses defaults and bounds", () => {
  const normal = parsePaginationParams({ page: "2", limit: "20" });
  assert.deepEqual(normal, {
    page: 2,
    limit: 20,
    offset: 20,
    maxLimit: 200,
  });

  const invalid = parsePaginationParams({ page: "-9", limit: "nope" });
  assert.equal(invalid.page, 1);
  assert.equal(invalid.limit, 50);
  assert.equal(invalid.offset, 0);

  const capped = parsePaginationParams({ page: "1", limit: "5000" });
  assert.equal(capped.limit, 200);
});

test("/user/voters/search: combined filter + pagination metadata", () => {
  const pagination = parsePaginationParams({ page: "3", limit: "10" });
  const meta = buildPaginationMeta({
    page: pagination.page,
    limit: pagination.limit,
    total: 26,
  });

  assert.equal(meta.page, 3);
  assert.equal(meta.limit, 10);
  assert.equal(meta.total, 26);
  assert.equal(meta.totalPages, 3);
});

test("/sessions/:id/voters: filters always scoped to session id", () => {
  const sessionId = "7f569061-b76d-4987-8478-9eb4d8fca1d1";
  const { where, values } = buildVoterFilterClause(
    {
      sessionId: "wrong-session",
      session_id: "still-wrong",
      voter_id: "KLM111",
    },
    { forceSessionId: sessionId },
  );

  assert.equal(where[0], "session_id = $1");
  assert.equal(values[0], sessionId);
  assert.ok(where.includes("voter_id = $2"));
  assert.equal(values[1], "KLM111");
});

test("/sessions/:id/voters: pagination edge cases and out-of-range semantics", () => {
  const pagination = parsePaginationParams({ page: "999", limit: "15" });
  assert.equal(pagination.page, 999);
  assert.equal(pagination.limit, 15);
  assert.equal(pagination.offset, 14970);

  const meta = buildPaginationMeta({
    page: pagination.page,
    limit: pagination.limit,
    total: 40,
  });

  assert.equal(meta.totalPages, 3);
  assert.equal(meta.page, 999);
});

test("deterministic voter ordering includes serial_number and voter_id", () => {
  assert.match(VOTER_DEFAULT_ORDER_SQL, /serial_number ASC/);
  assert.match(VOTER_DEFAULT_ORDER_SQL, /voter_id ASC/);
  assert.match(VOTER_DEFAULT_ORDER_SQL, /id ASC/);
});
