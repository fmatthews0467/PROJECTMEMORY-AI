// Función segura en el servidor: la clave de Claude vive acá (variable de entorno en Vercel),
// nunca llega al navegador del usuario.

const TOOL = {
  name: 'extract_meeting_memory',
  description: 'Extrae la memoria estructurada de una reunión a partir de su transcripción.',
  input_schema: {
    type: 'object',
    properties: {
      es_transcripcion_valida: {
        type: 'boolean',
        description: 'true si el texto es una transcripción real de una reunión con contenido aprovechable; false si no lo es o no se puede extraer nada útil.'
      },
      resumen: { type: 'string' },
      proxima_reunion: {
        type: 'string',
        description: 'Fecha ISO YYYY-MM-DD de la próxima reunión si se menciona (incluso de forma relativa, ej. "el próximo martes", resuelta usando la fecha de esta reunión como referencia). Cadena vacía si no se menciona.'
      },
      decisiones: {
        type: 'array',
        items: { type: 'object', properties: { texto: { type: 'string' }, tema: { type: 'string', description: 'vacío si la reunión no mezcla varios temas/clientes' } }, required: ['texto'] }
      },
      riesgos: {
        type: 'array',
        items: { type: 'object', properties: { texto: { type: 'string' }, tema: { type: 'string' } }, required: ['texto'] }
      },
      preguntas_abiertas: {
        type: 'array',
        items: { type: 'object', properties: { texto: { type: 'string' }, tema: { type: 'string' } }, required: ['texto'] }
      },
      aprendizajes: {
        type: 'array',
        items: { type: 'object', properties: { texto: { type: 'string' }, tema: { type: 'string' } }, required: ['texto'] }
      },
      tareas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            descripcion: { type: 'string' },
            tema: { type: 'string' },
            tipo: {
              type: 'string',
              enum: ['accion_propia', 'en_espera_terceros'],
              description: "'accion_propia' si alguien del equipo debe hacer algo; 'en_espera_terceros' si se está esperando una respuesta externa (cliente, banco, proveedor, etc.)."
            },
            responsable: { type: 'string', description: 'Nombre de la persona a cargo, vacío si no se menciona.' },
            fecha_vencimiento: {
              type: 'string',
              description: 'Fecha ISO YYYY-MM-DD resuelta a partir de la fecha de la reunión, incluso si se dijo en forma relativa (ej. "el próximo martes"). Vacío si no hay ninguna mención de fecha.'
            }
          },
          required: ['descripcion', 'tipo']
        }
      }
    },
    required: ['es_transcripcion_valida', 'resumen', 'decisiones', 'riesgos', 'preguntas_abiertas', 'aprendizajes', 'tareas']
  }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido.' });
    return;
  }

  const { transcript, fechaReunion } = req.body || {};
  if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 20) {
    res.status(400).json({ error: 'Transcripción vacía o demasiado corta.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Falta configurar ANTHROPIC_API_KEY en las variables de entorno de Vercel.' });
    return;
  }

  const systemPrompt = `Sos un asistente que analiza transcripciones de reuniones de trabajo (en español) y extrae memoria estructurada: resumen, decisiones, riesgos, preguntas abiertas, aprendizajes y tareas.
La fecha de esta reunión es ${fechaReunion || 'desconocida'}; usala como referencia para resolver cualquier fecha relativa mencionada en la transcripción (ej. "el próximo martes", "en dos semanas", "esta semana").
Si la reunión mezcla varios clientes o asuntos distintos, etiquetá cada decisión/riesgo/pregunta/aprendizaje/tarea con el campo "tema" correspondiente; si no mezcla temas, dejá "tema" vacío.

MUY IMPORTANTE sobre el array "tareas": tu objetivo principal es que el usuario pueda controlar que los compromisos se cumplan en tiempo y forma. Por eso, CUALQUIER mención de que una persona específica (del equipo o externa) va a hacer, enviar, contactar, revisar, preparar, mandar, confirmar o resolver algo, DEBE registrarse como un elemento del array "tareas" con esa persona en "responsable" — incluso si esa misma acción también quedó mencionada como parte de una "decisión". Es decir: las decisiones y las tareas NO son excluyentes. Si en la transcripción se decide algo Y esa decisión implica que alguien puntual debe ejecutar una acción concreta, registrá AMBAS cosas: la decisión en "decisiones" y la acción con su responsable en "tareas". No dejes "tareas" vacío solo porque esas acciones ya aparecen dentro de "decisiones".
Ejemplos de frases que SIEMPRE deben generar una tarea: "Claudio lo contactará por LinkedIn" → tarea con responsable "Claudio"; "Alan intentará contactar a Erick Arteaga" → tarea con responsable "Alan"; "Paris va a enviar las métricas" → tarea con responsable "Paris".
Para cada tarea, clasificá "tipo" como accion_propia (alguien del equipo debe hacer algo) o en_espera_terceros (se espera respuesta de alguien externo, sin que nadie del equipo tenga una acción pendiente).
Si el texto no es una transcripción de una reunión real o no tiene contenido aprovechable, marcá es_transcripcion_valida en false y dejá los demás campos vacíos.
Siempre respondé llamando a la herramienta extract_meeting_memory.`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: systemPrompt,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'extract_meeting_memory' },
        messages: [{ role: 'user', content: transcript.slice(0, 150000) }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      res.status(502).json({ error: 'Error llamando a Claude: ' + errText });
      return;
    }

    const data = await anthropicRes.json();
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
    if (!toolUse) {
      res.status(502).json({ error: 'Claude no devolvió un resultado estructurado.' });
      return;
    }

    res.status(200).json(toolUse.input);
  } catch (err) {
    res.status(500).json({ error: 'Error inesperado: ' + err.message });
  }
};
