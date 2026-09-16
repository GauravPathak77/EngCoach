import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ensureSchema } from '@/db/migrate';
import { getCurrentUser } from '@/server/auth';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await ensureSchema();
  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  return (
    <div className="min-h-dvh">
      <nav className="border-b border-[var(--color-line)] px-5 py-3">
        <div className="mx-auto flex max-w-5xl items-center gap-6">
          <Link href="/home" className="text-sm font-semibold tracking-tight">
            EngCoach
          </Link>
          <div className="flex gap-4 text-sm text-[var(--color-muted)]">
            <Link href="/home" className="hover:text-[var(--color-text)]">Practise</Link>
            <Link href="/progress" className="hover:text-[var(--color-text)]">Progress</Link>
            <Link href="/settings" className="hover:text-[var(--color-text)]">Settings</Link>
          </div>
          <span className="ml-auto text-xs text-[var(--color-dim)]">{user.email}</span>
        </div>
      </nav>
      {children}
    </div>
  );
}
