import { cn } from "@/lib/utils";
import { PLATFORM_CONFIG } from "@/lib/engagement-types";
import { Instagram, Music, Youtube, Twitter, Facebook } from "lucide-react";

interface PlatformSelectorProps {
  selected: string;
  onSelect: (platform: string) => void;
  availablePlatforms?: string[]; // Only show platforms with active bundles
}

const iconMap = {
  Instagram,
  Music,
  Youtube,
  Twitter,
  Facebook,
};

export function PlatformSelector({ selected, onSelect, availablePlatforms }: PlatformSelectorProps) {
  // Filter platforms based on availablePlatforms prop
  const platformsToShow = availablePlatforms
    ? Object.entries(PLATFORM_CONFIG).filter(([key]) => availablePlatforms.includes(key))
    : Object.entries(PLATFORM_CONFIG);

  if (platformsToShow.length === 0) {
    return (
      <div className="text-center py-4 text-muted-foreground">
        No platforms configured. Contact admin to set up engagement bundles.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-3">
      {platformsToShow.map(([key, config]) => {
        const Icon = iconMap[config.icon as keyof typeof iconMap];
        const isSelected = selected === key;

        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={cn(
              "flex items-center gap-2.5 px-6 py-3.5 rounded-full font-black text-xs uppercase tracking-widest transition-all duration-200",
              isSelected
                ? `bg-gradient-to-r ${config.color} text-slate-900 shadow-[0_8px_24px_rgba(0,0,0,0.18)] scale-[1.02] ring-2 ring-border`
                : "bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200/70 hover:text-slate-800 hover:border-slate-300"
            )}
          >
            <Icon className={cn("h-4 w-4", isSelected ? "text-slate-900" : "text-slate-500")} />
            <span>{config.label}</span>
          </button>
        );
      })}
    </div>
  );
}
