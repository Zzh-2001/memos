export const ROUTES = {
  ROOT: "/",
  HOME: "/home",
  ATTACHMENTS: "/attachments",
  INBOX: "/inbox",
  SETTING: "/setting",
  EXPLORE: "/explore",
  AUTH: "/auth",
} as const;

export type RouteKey = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteKey];
