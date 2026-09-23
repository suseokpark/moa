import { identifyUrl } from "./link-library.js";

/** Local form convenience only; the shared catalog validator remains authoritative. */
export function prepareLinkInput({ url, title = "" } = {}) {
  if (typeof url !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(url)) throw new Error("올바른 웹 주소를 입력해 주세요.");
  let address = url.trim();
  if (!/^https?:\/\//iu.test(address)) {
    if (!/^(?:[\p{L}\d-]+\.)+[\p{L}\d-]+(?::\d+)?(?:[/?#]|$)/u.test(address)) throw new Error("웹 주소를 입력해 주세요. 예: example.com 또는 https://example.com");
    address = `https://${address}`;
  }
  const identity = identifyUrl(address);
  if (typeof title !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(title) || title.trim().length > 300) throw new Error("이름은 300자 이내로 입력해 주세요.");
  return { url: identity.url, title: title.trim() || new URL(identity.url).hostname.replace(/^www\./iu, "") };
}
