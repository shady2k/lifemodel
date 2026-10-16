import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, Orbit, X } from 'lucide-react';
import { CreaturePresence, type CreaturePresenceValue } from './components/CreaturePresence';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar';
import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import i18n, { languageFor } from './i18n';
import { Conversation } from './Conversation';

function Creature() {
  return (
    <Avatar className="bg-primary text-primary-foreground">
      <AvatarFallback className="bg-primary text-primary-foreground">
        <Orbit aria-hidden="true" className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}

function Navigation() {
  const { t } = useTranslation();
  return (
    <Sidebar collapsible="none" className="hidden border-r border-sidebar-border md:flex">
      <SidebarHeader className="flex h-14 flex-row items-center gap-2 border-b px-4">
        <Orbit aria-hidden="true" className="size-5 text-primary" />
        <span className="font-semibold tracking-tight">lifemodel</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive>
                  <a href="#conversation">
                    <span>{t('conversation')}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarGroupLabel>{t('system')}</SidebarGroupLabel>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="http://boot.localhost/" target="_blank" rel="noopener noreferrer">
                    <span>{t('loader')}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function NowPanel({ creature }: { creature?: CreaturePresenceValue }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="now-title" className="flex h-full min-h-0 flex-col bg-sidebar">
      <header className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">
        <h2 id="now-title" className="text-sm font-medium">
          {t('now')}
        </h2>
      </header>
      <div className="flex items-center gap-3 p-4">
        <Creature />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">lifemodel</span>
          <CreaturePresence value={creature} />
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [showNowButton, setShowNowButton] = useState(
    () => window.matchMedia('(max-width: 1023px)').matches
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => {
      setShowNowButton(media.matches);
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
    };
  }, []);
  const [nowOpen, setNowOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [creature, setCreature] = useState<CreaturePresenceValue>();

  useEffect(() => {
    const language = languageFor(navigator.language);
    void i18n.changeLanguage(language);
  }, []);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const applySystemTheme = () => {
      document.documentElement.classList.toggle('dark', preference.matches);
    };
    applySystemTheme();
    preference.addEventListener('change', applySystemTheme);
    return () => {
      preference.removeEventListener('change', applySystemTheme);
    };
  }, []);

  return (
    <SidebarProvider>
      <div className="flex h-svh min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          {isMobile && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('openNavigation')}
              onClick={() => {
                setNavigationOpen(true);
              }}
            >
              <Menu aria-hidden="true" />
            </Button>
          )}
          <Creature />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium leading-tight">lifemodel</span>
            <CreaturePresence value={creature} />
          </div>
          {showNowButton && (
            <Button
              className="ml-auto"
              variant="outline"
              size="sm"
              onClick={() => {
                setNowOpen(true);
              }}
            >
              {t('openNow')}
            </Button>
          )}
        </header>
        <div className="flex min-h-0 flex-1">
          <Navigation />
          <SidebarInset
            aria-label={t('conversation')}
            className="flex min-h-0 min-w-0 flex-1 flex-row bg-background"
          >
            <section
              id="conversation"
              aria-label={t('conversation')}
              className="min-h-0 min-w-0 flex-1"
            >
              <Conversation onState={setCreature} />
            </section>
            <aside aria-label={t('now')} className="hidden w-80 shrink-0 border-l lg:block">
              <NowPanel creature={creature} />
            </aside>
          </SidebarInset>
        </div>
        <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
          <SheetContent side="left" showCloseButton={false} className="p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>{t('navigation')}</SheetTitle>
              <SheetDescription>{t('navigationDescription')}</SheetDescription>
            </SheetHeader>
            <nav aria-label={t('navigation')} className="flex flex-col gap-2 p-4 pt-14">
              <a
                href="#conversation"
                onClick={() => {
                  setNavigationOpen(false);
                }}
              >
                {t('conversation')}
              </a>
              <h2 className="mt-4 font-medium">{t('system')}</h2>
              <a href="http://boot.localhost/" target="_blank" rel="noopener noreferrer">
                {t('loader')}
              </a>
            </nav>
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('close')}
                className="absolute right-3 top-3"
              >
                <X aria-hidden="true" />
              </Button>
            </SheetClose>
          </SheetContent>
        </Sheet>
        <Sheet open={nowOpen} onOpenChange={setNowOpen}>
          <SheetContent side="right" showCloseButton={false} className="w-full p-0 sm:max-w-sm">
            <SheetHeader className="sr-only">
              <SheetTitle>{t('now')}</SheetTitle>
              <SheetDescription>{t('creatureDescription')}</SheetDescription>
            </SheetHeader>
            <NowPanel creature={creature} />
            <SheetClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('close')}
                className="absolute right-3 top-3"
              >
                <X aria-hidden="true" />
              </Button>
            </SheetClose>
          </SheetContent>
        </Sheet>
      </div>
    </SidebarProvider>
  );
}
