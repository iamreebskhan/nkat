/**
 * The 50 states plus DC, as USPS codes, for state pickers.
 *
 * Moved out of the onboarding wizard (audit R17) so the platform-admin payer
 * roster offers the same list the onboarding "Active states" step does: an org
 * can only operate where a payer can be listed. The `state` reference table
 * also holds the five territories; the admin API accepts any code in that
 * table, and this list is only what the pickers show.
 */
export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
] as const;
