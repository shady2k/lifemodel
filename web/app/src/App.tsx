import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Orbit } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import i18n from './i18n';

type CreatureState = 'awake';

function Creature({ state }: { state: CreatureState }) {
  return (
    <Avatar className="bg-primary text-primary-foreground">
      <AvatarFallback className="bg-primary text-primary-foreground">
        <Orbit aria-hidden="true" className="size-4" />
      </AvatarFallback>
      <span className="sr-only">{state}</span>
    </Avatar>
  );
}

function Navigation() {
  const { t } = useTranslation();
  return (
    <Sidebar className="border-r border-sidebar-border">
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
                <SidebarMenuButton asChild>
                  <a href="#system">
                    <span>{t('system')}</span>
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

function NowPanel() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="now-title" className="flex h-full min-h-0 flex-col bg-sidebar">
      <header className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">
        <h2 id="now-title" className="text-sm font-medium">
          {t('now')}
        </h2>
      </header>
      <div className="flex items-center gap-3 p-4">
        <Creature state="awake" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">lifemodel</span>
          <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('awake')}
          </span>
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [nowOpen, setNowOpen] = useState(false);

  useEffect(() => {
    const language = navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
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
          {isMobile && <SidebarTrigger aria-label={t('openNavigation')} />}
          <Creature state="awake" />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium leading-tight">lifemodel</span>
            <span role="status" className="text-xs text-muted-foreground">
              {t('awake')}
            </span>
          </div>
          {isMobile && (
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
            />
            <aside aria-label={t('now')} className="hidden w-80 shrink-0 border-l lg:block">
              <NowPanel />
            </aside>
          </SidebarInset>
        </div>
        <Sheet open={nowOpen} onOpenChange={setNowOpen}>
          <SheetContent side="right" className="w-full p-0 sm:max-w-sm">
            <SheetHeader className="sr-only">
              <SheetTitle>{t('now')}</SheetTitle>
              <SheetDescription>{t('creatureDescription')}</SheetDescription>
            </SheetHeader>
            <NowPanel />
          </SheetContent>
        </Sheet>
      </div>
    </SidebarProvider>
  );
}
