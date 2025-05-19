import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

serve(async (req) => {
  try {
    const { vini, piatto } = await req.json();

    if (!vini || !piatto) {
      return new Response(JSON.stringify({ error: "Dati mancanti" }), { status: 400 });
    }

    const prompt = `Ecco una lista di vini presenti in un ristorante:\n${vini.map(w => `- ${w.nome} (${w.categoria}, ${w.sottocategoria}, ${w.uvaggio || ''})`).join("\n")}\n\nSuggerisci 1 o 2 vini da abbinare al piatto: '${piatto}'. Rispondi solo con i nomi dei vini, su righe separate.`;

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return new Response(JSON.stringify({ error: "Chiave OpenAI mancante" }), { status: 500 });
    }

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

    if (!completion.ok) {
      const errText = await completion.text();
      return new Response(JSON.stringify({ error: "Errore OpenAI", detail: errText }), { status: 500 });
    }

    const json = await completion.json();
    const reply = json.choices?.[0]?.message?.content;

    return new Response(JSON.stringify({ suggestion: reply }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Errore interno", detail: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

