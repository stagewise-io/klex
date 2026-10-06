import { createRoot } from 'react-dom/client';

import { Button } from '@stagewise/ui/src/components/ui/button.tsx';
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from '@stagewise/ui/src/components/ui/navigation-menu.tsx';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from '@stagewise/ui/src/components/ui/sidebar.tsx';
import { IconGithub } from '@stagewise/ui/src/icons/nucleo/social-media/IconGithub.tsx';
import { IconMenuOutline18 } from '@stagewise/ui/src/icons/nucleo/ui-outline-18/IconMenuOutline18.tsx';
import { IconXmarkOutline18 } from '@stagewise/ui/src/icons/nucleo/ui-outline-18/IconXmarkOutline18.tsx';

function MobileNavigation() {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  if (!isMobile) return null;

  return (
    <>
      <Button
        className="rounded-full!"
        variant="ghost"
        size="icon-lg"
        aria-label="Open navigation"
        aria-expanded={openMobile}
        aria-haspopup="dialog"
        onClick={() => setOpenMobile(true)}
      >
        <IconMenuOutline18 />
      </Button>
      <Sidebar side="right" className="new-mobile-nav">
        <SidebarHeader className="flex-row items-center justify-end p-4">
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="Close navigation"
            onClick={() => setOpenMobile(false)}
          >
            <IconXmarkOutline18 />
          </Button>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="px-4">
            <SidebarMenu className="gap-2">
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  render={<a href="https://docs.klex.bot" />}
                  onClick={() => setOpenMobile(false)}
                >
                  Docs
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  render={<a href="https://github.com/stagewise-io/klex" />}
                  onClick={() => setOpenMobile(false)}
                >
                  <IconGithub aria-hidden="true" />
                  <span>GitHub</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </>
  );
}

export function NewNav() {
  return (
    <SidebarProvider
      defaultOpen={false}
      className="new-nav-content min-h-0 w-auto items-center"
    >
      <NavigationMenu className="new-desktop-nav flex-none">
        <NavigationMenuList className="gap-2">
          <NavigationMenuItem>
            <NavigationMenuLink href="https://docs.klex.bot">
              Docs
            </NavigationMenuLink>
          </NavigationMenuItem>
          <NavigationMenuItem>
            <NavigationMenuLink
              className="new-github"
              href="https://github.com/stagewise-io/klex"
              aria-label="GitHub"
            >
              <IconGithub size={16} aria-hidden="true" />
              <span>GitHub</span>
            </NavigationMenuLink>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>
      <Button
        className="new-header-cta rounded-full"
        size="lg"
        nativeButton={false}
        role="link"
        render={<a href="https://cloud.klex.bot" />}
      >
        Create a Klex Bot
      </Button>
      <MobileNavigation />
    </SidebarProvider>
  );
}

export function mountNavigation() {
  const host = document.getElementById('new-nav');
  if (!host) throw new Error('The navigation container is missing.');
  const root = createRoot(host);
  root.render(<NewNav />);
  return () => root.unmount();
}
