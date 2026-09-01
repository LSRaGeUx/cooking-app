"use client";

import { useState } from "react";

/**
 * A recipe photo, loaded from wherever it lives.
 *
 * Nothing is copied onto this server: a self-hosted install should not grow an
 * image store, a thumbnailer and a cleanup job for a field the spec calls nice
 * to have. The cost is that the address must be https and that the host sees
 * the reader, which the form says in as many words.
 *
 * A plain `img` rather than `next/image`, because the optimizer would need an
 * allowlist of every recipe site anyone might ever paste, and `referrerPolicy`
 * keeps the page the reader is on out of the request.
 *
 * Most libraries are mostly photo-less, so the fallback is not an afterthought:
 * the caller passes what to draw instead, which is how a recipe with no picture
 * still gets a field of its own colour rather than a hole in the grid.
 */
export function RecipeImage({
  src,
  alt,
  className,
  fallback = null,
}: {
  src: string | null;
  alt: string;
  className?: string;
  fallback?: React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);

  // A dead link is common on recipe sites and is not worth a broken-image icon
  // or an error message: the recipe reads perfectly well without the photo.
  if (src === null || broken) return <>{fallback}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className={className}
    />
  );
}
