import { onRequestPost as __cfp_login_ts_onRequestPost } from "C:\\Users\\amonh\\Documents\\!My Documents\\NomaMusicWebsite\\functions\\cfp_login.ts"
import { onRequest as ___middleware_ts_onRequest } from "C:\\Users\\amonh\\Documents\\!My Documents\\NomaMusicWebsite\\functions\\_middleware.ts"

export const routes = [
    {
      routePath: "/cfp_login",
      mountPath: "/",
      method: "POST",
      middlewares: [],
      modules: [__cfp_login_ts_onRequestPost],
    },
  {
      routePath: "/",
      mountPath: "/",
      method: "",
      middlewares: [___middleware_ts_onRequest],
      modules: [],
    },
  ]