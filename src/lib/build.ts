/** True in dev builds only — gates factory export (admin). */
export function isDevBuild(): boolean {
  return __BUILD_MODE__ === "dev";
}