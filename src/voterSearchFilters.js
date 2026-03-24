function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function firstValue(params, keys) {
  for (const key of keys) {
    if (hasValue(params?.[key])) {
      return String(params[key]).trim();
    }
  }
  return "";
}

export const VOTER_DEFAULT_ORDER_SQL = `
  NULLIF(regexp_replace(serial_number, '[^0-9]', '', 'g'), '')::INT NULLS LAST,
  serial_number ASC,
  voter_id ASC NULLS LAST,
  id ASC
`;

export function parsePaginationParams(params = {}, options = {}) {
  const defaultPage = Number.isInteger(options.defaultPage)
    ? options.defaultPage
    : 1;
  const defaultLimit = Number.isInteger(options.defaultLimit)
    ? options.defaultLimit
    : 50;
  const maxLimit = Number.isInteger(options.maxLimit) ? options.maxLimit : 200;

  const rawPage = Number.parseInt(String(params.page ?? ""), 10);
  const rawLimit = Number.parseInt(String(params.limit ?? ""), 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : defaultPage;
  const limitedRaw =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : defaultLimit;
  const limit = Math.max(1, Math.min(limitedRaw, maxLimit));
  const offset = (page - 1) * limit;

  return { page, limit, offset, maxLimit };
}

export function buildVoterFilterClause(
  params,
  { startIndex = 1, forceSessionId = null } = {},
) {
  const where = [];
  const values = [];
  let idx = startIndex;

  const push = (sql, value) => {
    where.push(`${sql} $${idx}`);
    values.push(value);
    idx += 1;
  };

  const sessionId = hasValue(forceSessionId)
    ? String(forceSessionId).trim()
    : firstValue(params, ["sessionId", "session_id"]);

  if (sessionId) {
    push("session_id =", sessionId);
  }

  const name = firstValue(params, ["name"]);
  const voterId = firstValue(params, ["voterId", "voter_id"]);
  const relationName = firstValue(params, ["relationName", "relation_name"]);
  const partNumber = firstValue(params, [
    "partNumber",
    "part_number",
    "boothNo",
    "booth_no",
  ]);
  const houseNumber = firstValue(params, ["houseNumber", "house_number"]);
  const serialNumber = firstValue(params, ["serialNumber", "serial_number"]);
  const minAge = firstValue(params, ["minAge", "min_age"]);
  const maxAge = firstValue(params, ["maxAge", "max_age"]);
  const assembly = firstValue(params, ["assembly"]);
  const section = firstValue(params, ["section"]);
  const gender = firstValue(params, ["gender"]);
  const religion = firstValue(params, ["religion"]);

  if (name) {
    push("LOWER(name) LIKE", `%${name.toLowerCase()}%`);
  }

  if (voterId) {
    push("voter_id =", voterId);
  }

  if (relationName) {
    push("LOWER(relation_name) LIKE", `%${relationName.toLowerCase()}%`);
  }

  if (partNumber) {
    push("part_number =", partNumber);
  }

  if (houseNumber) {
    push("house_number =", houseNumber);
  }

  if (serialNumber) {
    push("serial_number =", serialNumber);
  }

  if (assembly) {
    push("LOWER(assembly) LIKE", `%${assembly.toLowerCase()}%`);
  }

  if (section) {
    push("LOWER(section) LIKE", `%${section.toLowerCase()}%`);
  }

  if (gender) {
    push("LOWER(gender) =", gender.toLowerCase());
  }

  if (religion) {
    push("LOWER(religion) =", religion.toLowerCase());
  }

  if (minAge) {
    const val = Number(minAge);
    if (!Number.isNaN(val)) {
      push("age >=", val);
    }
  }

  if (maxAge) {
    const val = Number(maxAge);
    if (!Number.isNaN(val)) {
      push("age <=", val);
    }
  }

  return { where, values, nextIndex: idx };
}

export function buildPaginationMeta({ page, limit, total }) {
  const safeTotal = Number(total) || 0;
  return {
    page,
    limit,
    total: safeTotal,
    totalPages: safeTotal === 0 ? 0 : Math.ceil(safeTotal / limit),
  };
}
