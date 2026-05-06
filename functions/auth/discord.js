import { handleOAuthStart } from "../_shared/oauth.js";

export function onRequestGet(context) {
  return handleOAuthStart(context, "discord");
}
