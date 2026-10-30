import type { ComponentType, ReactNode } from 'react';
import type { LoaderPlugin } from 'fumadocs-core/source';
import { createElement } from 'react';
import type { IconProps } from '@phosphor-icons/react/dist/lib/types';
import {
  Anchor,
  ArrowsClockwise,
  ArrowsLeftRight,
  ArrowSquareOut,
  ArrowUUpLeft,
  Atom,
  BookOpen,
  BookOpenText,
  Books,
  Bridge,
  Bug,
  Calculator,
  Coins,
  Compass,
  Code,
  CurrencyBtc,
  CurrencyEth,
  CurrencyCircleDollar,
  Cube,
  DownloadSimple,
  Drop,
  FileText,
  Flag,
  Gear,
  FlowArrow,
  Heartbeat,
  Key,
  Lightbulb,
  ListBullets,
  MagicWand,
  MapTrifold,
  Package,
  PaperPlaneRight,
  PaperPlaneTilt,
  Path,
  PlusCircle,
  Pulse,
  PuzzlePiece,
  Question,
  Receipt,
  Robot,
  RocketLaunch,
  ShieldCheck,
  Shuffle,
  Stack,
  Star,
  SunHorizon,
  Tag,
  Timer,
  Wallet,
  Waves,
  XCircle,
  ClockCounterClockwise,
  HandWithdraw,
} from '@phosphor-icons/react/dist/ssr';

/**
 * Phosphor (free, regular weight) icons addressable by name from `icon:` frontmatter,
 * meta.json `icon`, and `---[Name]Section---` separators. Add a name here to use it.
 */
export const icons: Record<string, ComponentType<IconProps>> = {
  Anchor, ArrowsClockwise, ArrowsLeftRight, ArrowSquareOut, ArrowUUpLeft, Atom, BookOpen, BookOpenText, Books,
  Bridge, Bug, Calculator, Coins, Compass, Code, CurrencyBtc, CurrencyEth, CurrencyCircleDollar, Cube,
  DownloadSimple, Drop, FileText, Flag, FlowArrow, Gear, Heartbeat, Key, Lightbulb, ListBullets, MagicWand,
  MapTrifold, Package, PaperPlaneRight, PaperPlaneTilt, Path, PlusCircle, Pulse, PuzzlePiece, Question,
  Receipt, Robot, RocketLaunch, ShieldCheck, Shuffle, Stack, Star, SunHorizon, Tag, Timer, Wallet, Waves,
  XCircle, ClockCounterClockwise, HandWithdraw,
};

export function renderIcon(name: string | undefined): ReactNode {
  if (!name) return undefined;
  const Icon = icons[name];
  if (!Icon) throw new Error(`Unknown icon "${name}" (add it to docs/lib/icons.tsx)`);
  return createElement(Icon, { weight: 'regular', 'aria-hidden': true });
}

/** Loader plugin: turns `icon` names (page frontmatter, meta.json, separators) into Phosphor elements. */
export function phosphorIcons(): LoaderPlugin {
  const replace = <T extends { icon?: unknown }>(node: T): T => {
    if (node.icon === undefined || typeof node.icon === 'string') node.icon = renderIcon(node.icon as string | undefined);
    return node;
  };
  return {
    name: 'tidepool:phosphor-icons',
    transformPageTree: { file: replace, folder: replace, separator: replace },
  };
}
