/**
 * The USCDI demographic fields (0128), for intake and the chart's Identity card.
 * A patient may decline each one, and that is recorded as an answer: a certified
 * record has to tell "asked and declined" from "never asked".
 */
"use client";

import { Field, Select } from "@/components/forms/field";
import { DECLINED, ETHNICITY_OPTIONS, LANGUAGE_OPTIONS, RACE_OPTIONS } from "@/lib/features/patients/uscdi";

export function RacePicker({ value, onChange, idPrefix }: { value: string[]; onChange: (codes: string[]) => void; idPrefix: string }) {
  const declined = value.includes(DECLINED);
  const toggle = (code: string, on: boolean) => {
    // Declining stands alone, and choosing a category takes it back.
    if (code === DECLINED) return onChange(on ? [DECLINED] : []);
    onChange(on ? [...value.filter((c) => c !== DECLINED), code] : value.filter((c) => c !== code));
  };
  return (
    <fieldset className="text-sm">
      <legend className="block text-xs font-medium text-slate-700 mb-1">
        Race <span className="font-normal text-slate-500">(optional, as many as apply)</span>
      </legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {RACE_OPTIONS.map((r) => (
          <label key={r.code} htmlFor={`${idPrefix}-${r.code}`} className="flex items-center gap-2">
            <input id={`${idPrefix}-${r.code}`} type="checkbox" checked={value.includes(r.code)} onChange={(e) => toggle(r.code, e.target.checked)} />
            <span>{r.label}</span>
          </label>
        ))}
        <label htmlFor={`${idPrefix}-declined`} className="flex items-center gap-2">
          <input id={`${idPrefix}-declined`} type="checkbox" checked={declined} onChange={(e) => toggle(DECLINED, e.target.checked)} />
          <span>Declined to answer</span>
        </label>
      </div>
    </fieldset>
  );
}

export function EthnicityField({ id, value, onChange }: { id: string; value: string; onChange: (e: { target: { value: string } }) => void }) {
  return (
    <Field id={id} label="Ethnicity" optional>
      <Select id={id} value={value} onChange={onChange}>
        <option value="">—</option>
        {ETHNICITY_OPTIONS.map((e) => (
          <option key={e.code} value={e.code}>
            {e.label}
          </option>
        ))}
        <option value={DECLINED}>Declined to answer</option>
      </Select>
    </Field>
  );
}

export function LanguageField({ id, value, onChange }: { id: string; value: string; onChange: (e: { target: { value: string } }) => void }) {
  return (
    <Field id={id} label="Preferred language" optional>
      <Select id={id} value={value} onChange={onChange}>
        <option value="">—</option>
        {LANGUAGE_OPTIONS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
        <option value={DECLINED}>Declined to answer</option>
      </Select>
    </Field>
  );
}
