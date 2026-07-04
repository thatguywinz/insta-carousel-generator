/**
 * Per-carousel-item media descriptor. A carousel is a mix of image and video
 * children; this carries the published URL, its Instagram media type, and (for
 * video) the poster image used in the preview and as the grid thumbnail.
 */
export type MediaType = 'IMAGE' | 'VIDEO';

export interface MediaDescriptor {
  url: string;
  type: MediaType;
  /** For VIDEO items: the poster (t=0 frame) image URL. */
  posterUrl?: string;
}

/**
 * Back-compat bridge. Manifests written before motion stored a flat
 * `slideUrls: string[]` of image URLs and no `slideMedia`. Normalize either
 * shape to descriptors so an existing DRAFT_READY draft still publishes as an
 * image-only carousel under the new code.
 */
export function normalizeMedia(
  slideMedia: MediaDescriptor[] | undefined,
  slideUrls: string[] | undefined,
): MediaDescriptor[] {
  if (slideMedia && slideMedia.length > 0) return slideMedia;
  return (slideUrls ?? []).map((url) => ({ url, type: 'IMAGE' as const }));
}
