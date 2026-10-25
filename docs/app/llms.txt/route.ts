import { docsLlms } from '@/lib/source';
import { llmsHeader } from '@/lib/llms-header';

export const revalidate = false;

export async function GET() {
  const index = (await docsLlms.index()).replace(/^# .*\n+/, '');
  return new Response(`${llmsHeader}## Docs\n\n${index}`);
}
