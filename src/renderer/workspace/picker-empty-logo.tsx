import brandIcon from "../../../resources/brand/icon.svg";

export function PickerEmptyLogo({
  size = 72,
  className = "asset-pick-logo",
}: {
  size?: number;
  className?: string;
} = {}) {
  return <img src={brandIcon} width={size} height={size} className={className} alt="" />;
}
