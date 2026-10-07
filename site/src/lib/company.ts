// C1 release marker 2026-10-07 (F17d): comment only; W5 needs a nonempty site/ delta.
export const COMPANY_ADDRESS = {
  name: "Yulan Ventures, LLC",
  street: "1211 W 6th St",
  suite: "Ste #600-188",
  city: "Austin",
  state: "TX",
  postalCode: "78703",
} as const;

export const COMPANY_ADDRESS_LINE = `${COMPANY_ADDRESS.name}, ${COMPANY_ADDRESS.street}, ${COMPANY_ADDRESS.suite}, ${COMPANY_ADDRESS.city}, ${COMPANY_ADDRESS.state} ${COMPANY_ADDRESS.postalCode}`;
