import L, { LatLng } from "leaflet";
import { CrosshairIcon, ExternalLinkIcon, MapPinIcon, MinusIcon, PlusIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MapContainer, Marker, useMap, useMapEvents } from "react-leaflet";
import { cn } from "@/lib/utils";
import { useInstance } from "@/contexts/InstanceContext";
import { type AMapTip, amapInputTips, amapRegeocode, defaultMarkerIcon, ThemedTileLayer } from "./map-utils";

interface LocationMarkerProps {
  position: LatLng | undefined;
  onChange: (position: LatLng) => void;
  readonly?: boolean;
}

const LocationMarker = ({ position: initialPosition, onChange, readonly: readOnly }: LocationMarkerProps) => {
  const [position, setPosition] = useState(initialPosition);
  const map = useMapEvents({
    click(e) {
      if (readOnly) {
        return;
      }
      setPosition(e.latlng);
      onChange(e.latlng);
    },
  });

  useEffect(() => {
    if (initialPosition) {
      setPosition(initialPosition);
      map.setView(initialPosition);
    } else {
      setPosition(undefined);
    }
  }, [initialPosition, map]);

  return position === undefined ? null : <Marker position={position} icon={defaultMarkerIcon}></Marker>;
};

// Reusable glass-style button component
interface GlassButtonProps {
  icon: ReactNode;
  onClick: () => void;
  ariaLabel: string;
  title: string;
}

const GlassButton = ({ icon, onClick, ariaLabel, title }: GlassButtonProps) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className={cn(
        "h-8 w-8 flex items-center justify-center rounded-lg",
        "cursor-pointer transition-all duration-200",
        "border border-border/80 bg-background/88 text-foreground shadow-sm backdrop-blur-md",
        "hover:scale-105 hover:bg-background hover:shadow-md active:scale-95",
        "focus:outline-none focus:ring-2 focus:ring-ring/60",
      )}
    >
      {icon}
    </button>
  );
};

// Container for all map control buttons
interface ControlButtonsProps {
  position: LatLng | undefined;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onOpenGoogleMaps: () => void;
  onLocateMe?: () => void;
}

const ControlButtons = ({ position, onZoomIn, onZoomOut, onOpenGoogleMaps, onLocateMe }: ControlButtonsProps) => {
  return (
    <div className="flex flex-col gap-1.5">
      {onLocateMe && (
        <GlassButton
          icon={<CrosshairIcon size={16} className="text-foreground" />}
          onClick={onLocateMe}
          ariaLabel="定位到当前位置"
          title="定位到当前位置"
        />
      )}
      {position && (
        <GlassButton
          icon={<ExternalLinkIcon size={16} className="text-foreground" />}
          onClick={onOpenGoogleMaps}
          ariaLabel="Open location in Google Maps"
          title="Open in Google Maps"
        />
      )}
      <GlassButton icon={<PlusIcon size={16} className="text-foreground" />} onClick={onZoomIn} ariaLabel="Zoom in" title="Zoom in" />
      <GlassButton icon={<MinusIcon size={16} className="text-foreground" />} onClick={onZoomOut} ariaLabel="Zoom out" title="Zoom out" />
    </div>
  );
};

// Custom Leaflet Control class
class MapControlsContainer extends L.Control {
  private container: HTMLDivElement | undefined = undefined;

  onAdd() {
    this.container = L.DomUtil.create("div", "");
    this.container.style.pointerEvents = "auto";

    // Prevent map interactions when clicking controls
    L.DomEvent.disableClickPropagation(this.container);
    L.DomEvent.disableScrollPropagation(this.container);

    return this.container;
  }

  onRemove() {
    this.container = undefined;
  }

  getContainer() {
    return this.container;
  }
}

interface MapControlsProps {
  position: LatLng | undefined;
  onLocateMe?: () => void;
}

const MapControls = ({ position, onLocateMe }: MapControlsProps) => {
  const map = useMap();
  const controlRef = useRef<MapControlsContainer | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const handleOpenInGoogleMaps = () => {
    if (!position) return;
    const url = `https://www.google.com/maps?q=${position.lat},${position.lng}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleZoomIn = () => {
    map.zoomIn();
  };

  const handleZoomOut = () => {
    map.zoomOut();
  };

  useEffect(() => {
    // Create custom Leaflet control
    const control = new MapControlsContainer({ position: "topright" });
    controlRef.current = control;
    control.addTo(map);
    setContainer(control.getContainer() ?? null);

    return () => {
      if (controlRef.current) {
        controlRef.current.remove();
        controlRef.current = null;
      }
      setContainer(null);
    };
  }, [map]);

  if (!container) {
    return null;
  }

  return createPortal(
    <ControlButtons
      position={position}
      onZoomIn={handleZoomIn}
      onZoomOut={handleZoomOut}
      onOpenGoogleMaps={handleOpenInGoogleMaps}
      onLocateMe={onLocateMe}
    />,
    container,
  );
};

const MapCleanup = () => {
  const map = useMap();

  useEffect(() => {
    return () => {
      // Cleanup map instance when component unmounts
      setTimeout(() => {
        if (map) {
          try {
            map.remove();
          } catch {
            // Ignore errors during cleanup
          }
        }
      }, 0);
    };
  }, [map]);

  return null;
};

interface LocationPickerProps {
  readonly?: boolean;
  latlng?: LatLng;
  onChange?: (position: LatLng) => void;
  onNameResolved?: (name: string) => void;
  className?: string;
}

const DEFAULT_CENTER_LAT_LNG = new LatLng(39.9042, 116.4074); // 北京
const noopOnLocationChange = () => {};

// ── 搜索框组件 ──
const LocationSearchBox = ({ onSelect }: { onSelect: (latlng: LatLng, name: string) => void }) => {
  const { generalSetting } = useInstance();
  const amapKey = generalSetting?.amapKey || "";
  const [query, setQuery] = useState("");
  const [tips, setTips] = useState<AMapTip[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!amapKey || !query.trim()) {
      setTips([]);
      setError(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await amapInputTips(query, amapKey);
        setTips(res);
        setOpen(true);
      } catch (err) {
        setTips([]);
        setOpen(true);
        setError(err instanceof Error ? err.message : "搜索失败");
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, amapKey]);

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSelect = (tip: AMapTip) => {
    const [lng, lat] = tip.location.split(",").map(Number);
    onSelect(new LatLng(lat, lng), tip.name);
    setQuery(tip.name);
    setOpen(false);
    setError(null);
  };

  if (!amapKey) return null;

  const hasContent = tips.length > 0 || error;

  return (
    <div ref={containerRef} className="absolute left-3 right-12 top-3 z-[460]">
      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) {
              setOpen(false);
              setError(null);
            }
          }}
          onFocus={() => {
            if (hasContent) setOpen(true);
          }}
          placeholder="搜索地点..."
          className={cn(
            "w-full h-9 pl-8 pr-3 rounded-lg border border-border bg-background/92 text-sm text-foreground shadow-sm backdrop-blur-sm",
            "placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/60",
          )}
        />
        {loading && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
            <div className="w-3.5 h-3.5 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
          </div>
        )}
      </div>
      {open && (
        <div className="mt-1 max-h-48 overflow-auto rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur-sm">
          {error ? (
            <div className="px-3 py-2 text-xs text-red-500">{error}</div>
          ) : tips.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">无搜索结果</div>
          ) : (
            tips.map((tip, idx) => (
              <button
                key={`${tip.adcode}-${idx}`}
                type="button"
                onClick={() => handleSelect(tip)}
                className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-accent/40 transition-colors"
              >
                <MapPinIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm text-foreground truncate">{tip.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{tip.district}</span>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// ── 主组件 ──
const LocationPicker = ({ readonly: readOnly = false, latlng, onChange = noopOnLocationChange, onNameResolved, className }: LocationPickerProps) => {
  const { generalSetting } = useInstance();
  const amapKey = generalSetting?.amapKey || "";
  const [mapCenter, setMapCenter] = useState<LatLng>(latlng || DEFAULT_CENTER_LAT_LNG);
  const [address, setAddress] = useState("");
  const [selectedName, setSelectedName] = useState<string>("");
  const hasInitRef = useRef(false);
  const nameFromSearchRef = useRef(false);

  // 反向地理编码
  const updateAddress = useCallback(
    async (lat: number, lng: number) => {
      const addr = await amapRegeocode(lng, lat, amapKey);
      setAddress(addr);
    },
    [amapKey],
  );

  // 初始化：尝试浏览器定位
  useEffect(() => {
    if (hasInitRef.current) return;
    hasInitRef.current = true;
    if (latlng) {
      setMapCenter(latlng);
      updateAddress(latlng.lat, latlng.lng);
      return;
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const ll = new LatLng(pos.coords.latitude, pos.coords.longitude);
          setMapCenter(ll);
          updateAddress(ll.lat, ll.lng);
        },
        () => {
          // 失败则保持北京
        },
        { enableHighAccuracy: false, timeout: 5000 },
      );
    }
  }, [latlng, updateAddress]);

  const handleChange = useCallback(
    (pos: LatLng) => {
      setMapCenter(pos);
      onChange(pos);
      setSelectedName("");
      nameFromSearchRef.current = false;
      updateAddress(pos.lat, pos.lng);
    },
    [onChange, updateAddress],
  );

  const handleSelectFromSearch = useCallback(
    (pos: LatLng, name: string) => {
      setMapCenter(pos);
      onChange(pos);
      setSelectedName(name);
      nameFromSearchRef.current = true;
      onNameResolved?.(name);
      updateAddress(pos.lat, pos.lng);
    },
    [onChange, updateAddress, onNameResolved],
  );

  const handleLocateMe = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const ll = new LatLng(pos.coords.latitude, pos.coords.longitude);
        setMapCenter(ll);
        onChange(ll);
        setSelectedName("");
        nameFromSearchRef.current = false;
        updateAddress(ll.lat, ll.lng);
      },
      () => {},
      { enableHighAccuracy: false, timeout: 5000 },
    );
  }, [onChange, updateAddress]);

  // 高德逆地理编码完成后，通知外部（仅地图点击/定位场景，搜索场景已在 handleSelectFromSearch 中直接通知）
  useEffect(() => {
    if (address && onNameResolved && !nameFromSearchRef.current) {
      onNameResolved(address);
    }
  }, [address, onNameResolved]);

  const statusLabel = readOnly ? "已选位置" : latlng ? "已选位置" : "点击地图选择位置";

  return (
    <div
      className={cn(
        "memo-location-map relative isolate h-80 w-full overflow-hidden rounded-xl border border-border bg-background shadow-sm",
        className,
      )}
    >
      <MapContainer
        className="h-full w-full !bg-muted"
        center={mapCenter}
        zoom={13}
        scrollWheelZoom={false}
        zoomControl={false}
        attributionControl={false}
      >
        <ThemedTileLayer />
        <LocationMarker position={mapCenter} readonly={readOnly} onChange={handleChange} />
        <MapControls position={latlng || mapCenter} onLocateMe={!readOnly ? handleLocateMe : undefined} />
        <MapCleanup />
      </MapContainer>

      {!readOnly && <LocationSearchBox onSelect={handleSelectFromSearch} />}

      {/* 状态栏 */}
      <div className="pointer-events-none absolute left-3 bottom-3 z-[450] flex items-center gap-2 max-w-[80%]">
        <div className="flex items-center gap-1.5 rounded-full border border-border bg-background/92 px-2.5 py-1 text-[11px] font-medium tracking-[0.02em] text-foreground/80 shadow-sm backdrop-blur-sm">
          <MapPinIcon className="w-3 h-3 shrink-0" />
          <span className="truncate">{selectedName || address || statusLabel}</span>
        </div>
      </div>
    </div>
  );
};

export default LocationPicker;
