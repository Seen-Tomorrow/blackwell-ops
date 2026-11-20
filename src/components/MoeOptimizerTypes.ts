/** What `moe_cache_autosize` reports: the VRAM the loaded launch left, and the cache it justifies. */
export interface MoeCacheSizing {
  device: number;
  free_mib: number;
  used_mib: number;
  reserve_mib: number;
  recommended_mib: number;
  engine_loaded: boolean;
}
