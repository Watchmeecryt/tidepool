import { docsLlms } from '@/lib/source';
import { llmsHeader } from '@/lib/llms-header';

export const revalidate = false;

export async function GET() {
  return new Response(`${llmsHeader}---\n\n${await docsLlms.full()}`);
}
