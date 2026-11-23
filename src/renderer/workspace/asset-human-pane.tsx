import type { ChannelView, ProjectAsset, SettingsValues } from "@link-studio/core";
import { Loader2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { useFilingPoll } from "../settings/use-filing-poll";
import { FilingCover } from "./human-picker";
import { PickerEmptyLogo } from "./picker-empty-logo";

type Images = SettingsValues["filingAssets"];
export type FiledChoice = {
  assetId: string;
  displayName: string;
  filed: { channel: ChannelView; image: Images[number] };
};
export function AssetHumanPane({
  query,
  assets,
  selected,
  reason,
  toggle,
}: {
  query: string;
  assets: ProjectAsset[];
  selected: { assetId: string }[];
  reason: (id: string) => string | undefined;
  toggle: (asset: FiledChoice | ProjectAsset) => void;
}) {
  const [channel, setChannel] = useState<ChannelView>();
  const [images, setImages] = useState<Images>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    async function load() {
      const list = await window.desktop.settings.channelList({});
      if (!list.ok) throw new Error();
      const source = list.value.find((item) => item.filing?.enabled);
      const result =
        source &&
        (await window.desktop.settings.filingAssets({
          id: source.id,
          expectedRevision: source.revision,
          action: "list",
        }));
      if (result && !result.ok) throw new Error();
      if (active) {
        setChannel(source);
        setImages(result?.value ?? []);
      }
    }
    void load()
      .catch(() => {
        if (active) setError("加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retry]);
  useFilingPoll(channel, images, loading || !!error, setImages, setError);
  if (loading)
    return (
      <div className="asset-pick-empty" role="status" aria-label="加载中">
        <Loader2 className="asset-pick-spinner" size={24} />
      </div>
    );
  if (error)
    return (
      <div className="asset-pick-empty" role="alert">
        <PickerEmptyLogo />
        <strong>{error}</strong>
        <span>
          <button
            type="button"
            className="asset-pick-reload"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试
          </button>
        </span>
      </div>
    );
  const groups = new Map<string, Images>();
  for (const item of images) {
    if (!item.humanName.toLowerCase().includes(query.trim().toLowerCase())) continue;
    const group = groups.get(item.humanId) ?? [];
    group.push(item);
    groups.set(item.humanId, group);
  }
  const visibleGroups = Array.from(groups).filter(([, members]) =>
    members.some((item) => item.hasSource),
  );
  if (!visibleGroups.length || !channel)
    return (
      <div className="asset-pick-empty">
        <PickerEmptyLogo />
        <strong>{query.trim() ? `没有找到“${query.trim()}”` : "真人库是空的"}</strong>
      </div>
    );
  return (
    <div className="asset-human-groups">
      {visibleGroups.map(([id, members]) => {
        const name = members[0]!.humanName;
        const groupStatus = members.some((item) => item.status === "active")
          ? "可用"
          : members.some((item) => item.status === "processing")
            ? "备案中"
            : "失败";
        return (
          <section key={id} aria-label={name}>
            <h3>
              <span>{name}</span>
              <small data-status={groupStatus}>{groupStatus}</small>
            </h3>
            <div className="asset-pick-grid">
              {members
                .filter((item) => item.hasSource)
                .sort((left, right) => left.order - right.order)
                .map((image) => {
                  const local = assets.find(
                    (asset) =>
                      asset.availability === "ready" &&
                      asset.metadata.filingChannel === channel.id &&
                      asset.metadata.filingImage === image.id,
                  );
                  const choice = local ?? {
                    assetId: `filed:${channel.id}:${image.id}`,
                    displayName: image.name,
                    filed: { channel, image },
                  };
                  const order = selected.findIndex((item) => item.assetId === choice.assetId) + 1;
                  const disabled = order
                    ? undefined
                    : image.status === "failed"
                      ? "备案失败"
                      : image.status === "processing"
                        ? "备案中"
                        : reason(choice.assetId);
                  return (
                    <motion.div
                      className="asset-pick-card"
                      key={image.id}
                      data-source="library"
                      data-selected={!!order || undefined}
                      data-disabled={!!disabled || undefined}
                      whileTap={disabled ? undefined : { scale: 0.985 }}
                    >
                      <div className="asset-pick-cover">
                        <FilingCover channel={channel} imageId={image.id} />
                      </div>
                      <button
                        className="asset-pick-hit"
                        type="button"
                        aria-label={choice.displayName}
                        aria-description={disabled}
                        aria-pressed={!!order}
                        disabled={!!disabled}
                        onClick={() => toggle(choice)}
                      />
                      <b aria-hidden>{order || ""}</b>
                      {disabled && <span className="asset-pick-reason">{disabled}</span>}
                      <span className="asset-card-name">{choice.displayName}</span>
                    </motion.div>
                  );
                })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
