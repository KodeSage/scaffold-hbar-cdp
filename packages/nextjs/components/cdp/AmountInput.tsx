type AmountInputProps = {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  /** Shown on the right of the label, e.g. "Wallet: 12.5". */
  hint?: string;
  /** Fills the field with the maximum allowed amount. */
  onMax?: () => void;
  disabled?: boolean;
};

export const AmountInput = ({ label, unit, value, onChange, error, hint, onMax, disabled }: AmountInputProps) => (
  <fieldset className="fieldset">
    <legend className="fieldset-legend flex w-full justify-between">
      <span>{label}</span>
      {hint && <span className="font-normal text-base-content/60">{hint}</span>}
    </legend>
    <label className={`input w-full ${error ? "input-error" : ""}`}>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.0"
        className="grow font-mono"
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value.replace(",", "."))}
      />
      {onMax && (
        <button type="button" className="btn btn-ghost btn-xs" onClick={onMax} disabled={disabled}>
          Max
        </button>
      )}
      <span className="text-base-content/60">{unit}</span>
    </label>
    {error && <p className="label text-error">{error}</p>}
  </fieldset>
);
