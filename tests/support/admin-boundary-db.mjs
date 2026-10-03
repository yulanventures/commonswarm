// The boundary test permits only the bounded anonymous audit. Any authority,
// issuance, credential, principal or victim lookup is a test failure.
export const securityReasons = [];
export default function postgres() {
  const sql = async (parts, ...values) => {
    const text = parts.join('?');
    if (text.includes('set_config(') && values.length === 0) return [];
    if (/^SELECT commonswarm_oauth\.record_admin_security_failure\(/u.test(text.trim()) && values.length === 1 &&
        ['invalid_token','invalid_dpop','invalid_request'].includes(values[0])) {
      securityReasons.push(values[0]); return [{record_admin_security_failure:true}];
    }
    throw new Error('unexpected_authority_database_work');
  };
  sql.begin = async (first, second) => (typeof first === 'function' ? first : second)(sql);
  return sql;
}
