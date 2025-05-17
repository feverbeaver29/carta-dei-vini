import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

serve(async (req) => {
  const { vini, piatto } = await req.json();

  const prompt = `Ecco una lista di vini presenti in un ristorante:\n${vini.map(w => `- ${w.nome} (${w.categoria}, ${w.sottocategoria}, ${w.uvaggio || ''})`).join("\n")}\n\nSuggerisci 1 o 2 vini da abbinare al piatto: '${piatto}'. Rispondi solo con i nomi dei vini, su righe separate.`;

  const openaiKey = Deno.env.get("OPENAI_API_KEY");

  const completion = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4-1106-preview",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7
    })
  });

  const json = await completion.json();
  const reply = json.choices?.[0]?.message?.content;

  return new Response(JSON.stringify({ suggestion: reply }), {
    headers: { "Content-Type": "application/json" },
  });
});
