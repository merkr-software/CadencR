/**
 * The desktop app's own UI components, re-exported without a fork. `@/`
 * resolves to `packages/desktop/src` at build time (vite alias + tsconfig
 * paths). Only self-contained modules belong here: test/components.test.ts
 * fails when one of them starts importing app code.
 *
 * `./card`, `./label` and `./empty-state` are kit-native: desktop has no such
 * primitive, so they live here, styled only with the theme tokens.
 */
export { cn } from "@/lib/utils";
export { Badge } from "@/components/ui/badge";
export { Button } from "@/components/ui/button";
export { Checkbox } from "@/components/ui/checkbox";
export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
export { Input } from "@/components/ui/input";
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverModality,
  PopoverTrigger,
} from "@/components/ui/popover";
export { Progress } from "@/components/ui/progress";
export { ScrollArea } from "@/components/ui/scroll-area";
export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export { Separator } from "@/components/ui/separator";
export { Skeleton } from "@/components/ui/skeleton";
export { Switch } from "@/components/ui/switch";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
export { Textarea } from "@/components/ui/textarea";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { Label } from "./label";
