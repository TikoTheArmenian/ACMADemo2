import { TAVUS_API_KEY } from '@/config';
import { IConversation } from '@/types';

export const createConversation = async (): Promise<IConversation> => {
  // Step 1: Create an echo-mode persona (BYOA — no LLM, no STT, no TTS pipeline)
  const personaRes = await fetch('https://tavusapi.com/v2/personas', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TAVUS_API_KEY,
    },
    body: JSON.stringify({
      persona_name: `ACMA Echo ${Date.now()}`,
      default_replica_id: 'raf6459c9b82',
      pipeline_mode: 'echo',
    }),
  });

  if (!personaRes.ok) {
    const body = await personaRes.text();
    console.error('Persona creation response:', body);
    throw new Error(`Persona creation failed (${personaRes.status}): ${body}`);
  }

  const persona = await personaRes.json();
  console.log('Created echo persona:', persona.persona_id);

  // Step 2: Create conversation with the echo persona + replica
  const convRes = await fetch('https://tavusapi.com/v2/conversations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': TAVUS_API_KEY,
    },
    body: JSON.stringify({
      persona_id: persona.persona_id,
      replica_id: 'raf6459c9b82',
      conversation_name: 'ACMA Demo',
    }),
  });

  if (!convRes.ok) {
    const body = await convRes.text();
    console.error('Conversation creation response:', body);
    throw new Error(`Conversation creation failed (${convRes.status}): ${body}`);
  }

  return await convRes.json();
};
