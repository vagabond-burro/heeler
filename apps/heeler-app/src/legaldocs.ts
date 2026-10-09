/** Where the guide's legal pages are, and the routes the app gives to
 * them. Its own module so the About box, the Help menu and the guide
 * test read the same strings. */

/** The Help menu item that opens the legal folder. A constant because
 * the About box quotes this path in prose, and prose that names a menu
 * item is prose that goes stale the moment the item is renamed. */
export const LEGAL_MENU_LABEL = "Legal Documents";

/** The open source notices, and the route the About box gives to them.
 *
 * These two exist to be checked against each other. The notice was
 * stranded once already: the user guide became a tree, only the tree is
 * bundled, and this page was left behind in the old flat folder, so for
 * several commits the About box confidently directed people to a page
 * that no longer shipped. LibRaw's CDDL-1.0 obliges us to carry that
 * notice, so a broken signpost is not cosmetic.
 *
 * `userguide.test.ts` walks the path below against the guide as it
 * actually ships, and fails if any segment stops being true. */
export const OPEN_SOURCE_FILE = "legal/open-source.md";
export const OPEN_SOURCE_MENU_PATH = `Help > ${LEGAL_MENU_LABEL} > Open source notices`;
