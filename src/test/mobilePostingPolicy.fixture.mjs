// Synthetic test database only; the deployed API uses the existing shared PostgreSQL function.
export const postingPolicySql = `
  CREATE OR REPLACE FUNCTION financial_transaction_posts(
    p_direction TEXT, p_status TEXT, p_payment_mode TEXT, p_cheque_status TEXT
  ) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
      WHEN LOWER(COALESCE(NULLIF(TRIM(p_status), ''), 'approved'))
        IN ('rejected', 'cancelled', 'deleted', 'void', 'voided') THEN FALSE
      WHEN (UPPER(TRIM(COALESCE(p_payment_mode, ''))) IN ('CHEQUE', 'CHECK')
            OR NULLIF(TRIM(COALESCE(p_cheque_status, '')), '') IS NOT NULL)
        AND (UPPER(TRIM(COALESCE(p_cheque_status, ''))) <> 'CLEARED'
             OR LOWER(TRIM(COALESCE(p_status, ''))) <> 'approved') THEN FALSE
      WHEN LOWER(TRIM(COALESCE(p_direction, ''))) = 'credit' THEN TRUE
      WHEN LOWER(TRIM(COALESCE(p_direction, ''))) = 'debit'
        THEN LOWER(COALESCE(NULLIF(TRIM(p_status), ''), 'approved')) = 'approved'
      ELSE FALSE
    END
  $$`;
