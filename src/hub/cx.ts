/**
 * Concatène des classes CSS. On n'utilise pas tailwind-merge ici : il confond les tokens
 * personnalisés (text-micro = taille, text-status-* = couleur) et supprime la taille.
 */
export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');
