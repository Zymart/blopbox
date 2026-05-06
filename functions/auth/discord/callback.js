import { handleOAuthCallback } from "../../_shared/oauth.js";

export function onRequestGet(context) {
  return handleOAuthCallback(context, "discord");
}
