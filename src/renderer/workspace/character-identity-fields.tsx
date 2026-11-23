import { useState } from "react";
import { episodeLabel } from "./episode-label";

export type CharacterIdentityChange = { name: string } | { look: string };

export function CharacterIdentityFields({
  name,
  look,
  episodes,
  change,
}: {
  name: string;
  look: string;
  episodes?: number[] | null;
  change: (patch: CharacterIdentityChange) => void;
}) {
  const [inputName, setInputName] = useState(name);
  return (
    <div className="character-identity">
      <div className="character-identity-grid">
        <label>
          角色名称
          <input
            value={inputName}
            maxLength={64}
            onChange={(event) => {
              const value = event.target.value;
              setInputName(value);
              if (value.trim()) change({ name: [...value.trim()].slice(0, 64).join("") });
            }}
            onBlur={() => {
              if (!inputName.trim()) setInputName(name);
            }}
          />
        </label>
        <label>
          形象名称
          <input
            value={look}
            maxLength={64}
            onChange={(event) => change({ look: event.target.value })}
          />
        </label>
      </div>
      {episodes && (
        <div className="character-identity-episodes">
          <span>出现集数</span>
          <span>{episodeLabel(episodes)}</span>
        </div>
      )}
    </div>
  );
}
