export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'DENY',
  'BULK',
  'OPENROWSET',
  'OPENQUERY',
  'DBCC',
  'BACKUP',
  'RESTORE',
  'SHUTDOWN',
  'RECONFIGURE',
  'WAITFOR',
];

const FORBIDDEN_PREFIXES = ['XP_', 'SP_'];

/**
 * Strip SQL string literals (single-quoted) to prevent bypass via strings.
 * Replaces content between single quotes with empty string literal ''.
 */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Strip SQL comments (line comments and block comments).
 */
function stripComments(sql: string): string {
  // Remove block comments (including nested-ish, non-greedy)
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Remove line comments
  result = result.replace(/--.*$/gm, ' ');
  return result;
}

/**
 * Normalize whitespace to single spaces and trim.
 */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Validates that a SQL query is read-only.
 * Defense-in-depth: this runs alongside readOnlyIntent and db_datareader permissions.
 */
export function validateReadOnlyQuery(sql: string): ValidationResult {
  if (!sql || !sql.trim()) {
    return { valid: false, error: 'Query cannot be empty' };
  }

  // Strip comments and string literals before analysis
  const stripped = normalize(stripStringLiterals(stripComments(sql)));

  if (!stripped) {
    return { valid: false, error: 'Query cannot be empty after stripping comments' };
  }

  const upper = stripped.toUpperCase();

  // Check first keyword: only SELECT and WITH (CTE) are allowed
  const firstWord = upper.split(/\s/)[0];
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return {
      valid: false,
      error: `Query must start with SELECT or WITH. Found: ${firstWord}`,
    };
  }

  if (/\bSELECT\b[^;]*\bINTO\b/i.test(upper)) {
    return { valid: false, error: 'SELECT INTO is not allowed' };
  }

  // Check for forbidden keywords as whole words
  for (const keyword of FORBIDDEN_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(upper)) {
      return { valid: false, error: `Forbidden keyword: ${keyword}` };
    }
  }

  // Check for forbidden prefixes (xp_, sp_)
  for (const prefix of FORBIDDEN_PREFIXES) {
    const regex = new RegExp(`\\b${prefix}\\w+`, 'i');
    if (regex.test(upper)) {
      return { valid: false, error: `Forbidden system procedure prefix: ${prefix}` };
    }
  }

  // Check for semicolons that might indicate multiple statements
  // Allow trailing semicolons but block mid-query semicolons
  const withoutTrailingSemicolon = stripped.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    return { valid: false, error: 'Multiple statements are not allowed' };
  }

  return { valid: true };
}
