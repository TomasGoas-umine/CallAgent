import { describe, expect, it } from 'vitest';
import { buildSenceAgentPatch } from '../../scripts/lib/sence-agent-config.js';
import { buildAgentDynamicVariables } from '../../src/services/agent-variables.js';
import { classifyCallOutcome } from '../../src/services/call-outcome-classifier.js';

describe('contrato del workflow Sence', () => {
  const config = buildSenceAgentPatch();
  it('todas las variables del saludo, prompt y etapas las proporciona el dispatcher', () => {
    const provided = buildAgentDynamicVariables({
      clientName: 'Empresa de prueba',
      courseName: 'Curso de prueba',
      orderNumber: 'TEST',
      motivo: 'riesgo_conexion_critico',
    });
    const referenced = [
      ...new Set([...JSON.stringify(config).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])),
    ];
    expect(referenced.sort()).toEqual(Object.keys(provided).sort());
    expect(
      Object.keys(
        config.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders,
      ).sort(),
    ).toEqual(Object.keys(provided).sort());
  });

  it('cada nodo es alcanzable, tiene salida hacia fin y ordena condiciones sin aristas perdidas', () => {
    const { nodes, edges } = config.workflow;
    expect(
      new Set(Object.values(edges).map((e) => [e.source, e.target].sort().join(':'))).size,
    ).toBe(Object.keys(edges).length);
    function reachable(start: string) {
      const seen = new Set<string>();
      function visit(id: string) {
        if (seen.has(id)) return;
        seen.add(id);
        for (const edgeId of nodes[id]!.edge_order) {
          const edge = edges[edgeId]!;
          visit(edge.source === id ? edge.target : edge.source);
        }
      }
      visit(start);
      return seen;
    }
    for (const [id, node] of Object.entries(nodes)) {
      expect(new Set(node.edge_order).size).toBe(node.edge_order.length);
      expect(node.edge_order.slice().sort()).toEqual(
        Object.keys(edges)
          .filter(
            (k) =>
              edges[k]!.source === id || (edges[k]!.target === id && edges[k]!.backward_condition),
          )
          .sort(),
      );
      for (const key of node.edge_order) expect(nodes[edges[key]!.target]).toBeDefined();
      expect(reachable(id).has('fin')).toBe(true);
    }
    expect(reachable('start_node').size).toBe(Object.keys(nodes).length);
  });

  it('rechazar contactos tiene prioridad sobre pedir humano y el avance normal en cada etapa activa', () => {
    for (const id of [
      'identificacion',
      'contexto',
      'contexto_dj',
      'diagnostico',
      'soporte',
      'acuerdo',
      'capacitacion_futura',
    ]) {
      const exits = config.workflow.nodes[id]!.edge_order.map(
        (k) => config.workflow.edges[k]!.target,
      );
      expect(exits.indexOf('no_contactar')).toBeLessThan(exits.indexOf('humano'));
      expect(exits).toContain('reagendar');
      expect(exits).toContain('no_disponible');
    }
  });

  it('mantiene acotado el contexto activo y separa la entrada de DJ del criterio A', () => {
    expect(config.conversation_config.agent.prompt.prompt.length).toBeLessThan(5500);
    expect(config.workflow.nodes.contexto_dj!.additional_prompt!.length).toBeLessThan(1100);
    expect(
      config.workflow.edges.identificacion_to_contexto_dj!.forward_condition.condition,
    ).toContain('riesgo_dj_critico');
    expect(config.workflow.edges.identificacion_to_contexto!.forward_condition.condition).toContain(
      'NO es riesgo_dj_critico',
    );
  });

  it('extrae los cinco campos consumidos por el backend con booleanos reales', () => {
    const result = classifyCallOutcome({
      type: 'post_call_transcription',
      event_timestamp: 0,
      data: { conversation_id: 'test', agent_id: 'test', status: 'done', analysis: {} },
    });
    expect(Object.keys(config.platform_settings.data_collection).sort()).toEqual(
      Object.keys(result.dataCollection).sort(),
    );
    expect(config.platform_settings.data_collection.requiere_humano.type).toBe('boolean');
    expect(config.platform_settings.data_collection.tiene_bloqueo_tecnico.type).toBe('boolean');
    // Todos los criterios en success hacen que el backend cierre como RESUELTO.
    // Solo medimos resolución; no agregar criterios de cortesía independientes.
    expect(config.platform_settings.evaluation.criteria.map((c) => c.id)).toEqual([
      'objetivo_resuelto',
    ]);
  });
});
