import { DivIcon } from "leaflet";
import { MapPinIcon } from "lucide-react";
import { useMemo } from "react";
import ReactDOMServer from "react-dom/server";
import { TileLayer } from "react-leaflet";
import { useAuth } from "@/contexts/AuthContext";
import { useInstance } from "@/contexts/InstanceContext";
import { resolveTheme } from "@/utils/theme";

const TILE_URLS = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
} as const;

const AMAP_TILE_URLS = {
  light: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  dark: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
} as const;

export const ThemedTileLayer = () => {
  const { userGeneralSetting } = useAuth();
  const { generalSetting } = useInstance();
  const isDark = useMemo(() => resolveTheme(userGeneralSetting?.theme || "system").includes("dark"), [userGeneralSetting?.theme]);
  const amapKey = generalSetting?.amapKey || "";
  const urls = amapKey ? AMAP_TILE_URLS : TILE_URLS;
  return <TileLayer url={isDark ? urls.dark : urls.light} subdomains={amapKey ? "1234" : "abcd"} />;
};

// ============================================================
// 高德 Web 服务 API 封装
// ============================================================

export interface AMapTip {
  name: string;
  district: string;
  adcode: string;
  location: string;
}

export interface AMapGeocodeResult {
  formatted_address: string;
  location: string;
}

/** 输入提示（搜索补全） */
export async function amapInputTips(keywords: string, key: string): Promise<AMapTip[]> {
  if (!key || !keywords.trim()) return [];
  const url = `https://restapi.amap.com/v3/assistant/inputtips?key=${key}&keywords=${encodeURIComponent(keywords.trim())}&datatype=all`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "1") {
    throw new Error(`高德API错误: ${data.info || "未知错误"} (code: ${data.infocode || "unknown"})`);
  }
  if (!Array.isArray(data.tips)) return [];
  return data.tips
    .filter((tip: Record<string, string>) => tip.location && tip.location.length > 0)
    .map((tip: Record<string, string>) => ({
      name: tip.name,
      district: tip.district,
      adcode: tip.adcode,
      location: tip.location,
    }));
}

/** 地理编码：地址 → 坐标 */
export async function amapGeocode(address: string, key: string): Promise<{ lng: number; lat: number } | null> {
  if (!key || !address.trim()) return null;
  const url = `https://restapi.amap.com/v3/geocode/geo?key=${key}&address=${encodeURIComponent(address.trim())}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === "1" && Array.isArray(data.geocodes) && data.geocodes.length > 0) {
    const loc = data.geocodes[0].location;
    const [lng, lat] = loc.split(",").map(Number);
    return { lng, lat };
  }
  return null;
}

/** 逆地理编码：坐标 → 地址 */
export async function amapRegeocode(lng: number, lat: number, key: string): Promise<string> {
  if (!key) return "";
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${key}&location=${lng},${lat}&extensions=all&radius=500`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "1" || !data.regeocode) return "";

  const regeo = data.regeocode;

  // 优先从 pois 中找大型地标（学校、医院、公园、商场、景区等），避免小店名称
  const landmarkKeywords = ["学校", "高等院校", "医院", "公园", "广场", "体育场", "景区", "科技园", "开发区"];
  if (Array.isArray(regeo.pois) && regeo.pois.length > 0) {
    for (const poi of regeo.pois as Array<{ name: string; type: string; distance: string }>) {
      if (landmarkKeywords.some((k) => poi.type.includes(k))) {
        return poi.name;
      }
    }
  }

  // 回退到 addressComponent 拼接的基础地址，避免 formatted_address 混入小店名
  const ac = regeo.addressComponent;
  if (ac) {
    const parts: string[] = [];
    const cityPart = [ac.province, ac.city, ac.district].filter((p): p is string => typeof p === "string" && p.length > 0).join("");
    const streetPart = [ac.township, ac.street, ac.number].filter((p): p is string => typeof p === "string" && p.length > 0).join("");
    if (cityPart) parts.push(cityPart);
    if (streetPart) parts.push(streetPart);
    if (parts.length > 0) return parts.join("");
  }

  return regeo.formatted_address || "";
}

interface MarkerIconOptions {
  fill?: string;
  size?: number;
  className?: string;
}

export const createMarkerIcon = (options?: MarkerIconOptions): DivIcon => {
  const { fill = "var(--primary)", size = 28, className = "" } = options || {};
  return new DivIcon({
    className: "relative border-none bg-transparent",
    html: ReactDOMServer.renderToString(
      <div className={`relative flex items-center justify-center ${className}`.trim()}>
        <MapPinIcon fill={fill} size={size} strokeWidth={1.9} style={{ filter: "drop-shadow(0 6px 10px rgba(15, 23, 42, 0.22))" }} />
      </div>,
    ),
    iconSize: [size + 8, size + 8],
    iconAnchor: [(size + 8) / 2, size + 4],
    popupAnchor: [0, -(size * 0.7)],
  });
};

export const defaultMarkerIcon = createMarkerIcon();
