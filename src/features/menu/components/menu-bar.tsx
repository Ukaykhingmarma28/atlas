import { Menubar } from "@base-ui/react/menubar";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { isActionId } from "@/features/keybindings/lib/actions";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { inWindowMenus, type RunnableItem } from "../lib/menu-model";
import { runMenuItem } from "../lib/run-menu-item";

const MENUS = inWindowMenus();

/**
 * The menu bar for Windows and Linux, drawn in Atlas's own titlebar: those
 * windows are frameless, so a native Win32/GTK bar would sit under it as a
 * second strip. The menus are the native macOS menu's (`src-tauri/menu.json`),
 * less the AppKit-only items, so the platforms list the same commands.
 */
export function MenuBar({ className }: { className?: string }) {
  return (
    <Menubar className={cn("flex items-center", className)} aria-label="Application menu">
      {MENUS.map((menu) => (
        <DropdownMenu key={menu.id}>
          <DropdownMenuTrigger
            className={cn(
              "flex h-control-sm items-center rounded px-2 text-xs text-secondary-foreground outline-none",
              "transition-colors duration-fast ease-out-strong",
              "hover:bg-element-hover hover:text-foreground",
              "data-[popup-open]:bg-element-selected data-[popup-open]:text-foreground",
              "focus-visible:bg-element-hover",
            )}
          >
            {menu.label}
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56">
            {menu.items.map((item, index) =>
              item.type === "separator" ? (
                <DropdownMenuSeparator key={`sep-${index}`} />
              ) : item.type === "role" ? null : (
                <MenuBarItem key={item.id} item={item} />
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </Menubar>
  );
}

function MenuBarItem({ item }: { item: RunnableItem }) {
  return (
    <DropdownMenuItem onClick={() => runMenuItem(item.id)}>
      {item.label}
      {item.type === "action" && isActionId(item.id) && <ItemShortcut id={item.id} />}
    </DropdownMenuItem>
  );
}

function ItemShortcut({ id }: { id: Parameters<typeof useActionShortcut>[0] }) {
  const shortcut = useActionShortcut(id);
  return shortcut ? <DropdownMenuShortcut>{shortcut.label}</DropdownMenuShortcut> : null;
}
