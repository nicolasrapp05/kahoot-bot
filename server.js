const express = require('express');
const cors = require('cors');
const Kahoot = require('kahoot.js-latest');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================================
// TRATAMENTO DE ERRO GLOBAL (Previne crash quando o Kahoot envia pacotes bugados)
// =========================================================================
process.on('uncaughtException', (err) => {
    console.error('⚠️ Erro ignorado da biblioteca Kahoot:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Promessa rejeitada ignorada:', reason);
});

// =========================================================================
// ESTADO GLOBAL E ESTATÍSTICAS
// =========================================================================
let botsAtivos = [];
let clientesSSE = [];
let perguntaAtualAvisada = false;
let fimDeJogoAvisado = false;

let stats = { botsAtivos: 0, votosEnviados: 0, perguntas: 0 };

const nomes = ["Lucas", "Pedro", "Gabriel", "Matheus", "Rafael", "Guilherme", "Enzo", "João", "Felipe", "Gustavo","Maria", "Ana", "Juliana", "Beatriz", "Larissa", "Camila", "Fernanda", "Letícia", "Gabriela", "Amanda","Bruno", "Thiago", "Daniel", "Eduardo", "Vinícius", "Leonardo", "Diego", "Carlos", "Paulo", "André","Carla", "Mariana", "Bruna", "Jéssica", "Patrícia", "Aline", "Bianca", "Luana", "Renata", "Natália"];
const sobrenomes = ["Silva", "Santos", "Oliveira", "Souza", "Rodrigues", "Ferreira", "Alves", "Pereira", "Lima", "Gomes","Costa", "Ribeiro", "Martins", "Carvalho", "Almeida", "Lopes", "Soares", "Fernandes", "Vieira", "Barbosa","Rocha", "Dias", "Nascimento", "Andrade", "Moreira", "Nunes", "Marques", "Machado", "Mendes", "Freitas"];

function gerarNomesUnicos(quantidade) {
    const todos = [];
    for (let n of nomes) for (let s of sobrenomes) todos.push(`${n} ${s}`);
    for (let i = todos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [todos[i], todos[j]] = [todos[j], todos[i]];
    }
    const result = [];
    for (let i = 0; i < quantidade; i++) result.push(todos[i % todos.length]);
    return result;
}

// =========================================================================
// FUNÇÕES AUXILIARES (SSE E LOGS)
// =========================================================================
function emitirLog(texto) {
    const linha = `[${new Date().toLocaleTimeString()}] ${texto}`;
    console.log(linha);
    clientesSSE.forEach(res => {
        try { res.write(`data: ${JSON.stringify({ tipo: 'log', mensagem: linha })}\n\n`); } catch (e) {}
    });
}

function emitirStats() {
    clientesSSE.forEach(res => {
        try { res.write(`data: ${JSON.stringify({ tipo: 'stats', dados: stats })}\n\n`); } catch (e) {}
    });
}

function avisarFimDeJogo(motivo) {
    if (!fimDeJogoAvisado) {
        fimDeJogoAvisado = true;
        emitirLog(`🏁 O JOGO ACABOU (${motivo})!`);
        clientesSSE.forEach(r => {
            try { r.write(`data: ${JSON.stringify({ tipo: 'fim_jogo' })}\n\n`); } catch (e) {}
        });
    }
}

// =========================================================================
// ROTAS DA API
// =========================================================================
app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clientesSSE.push(res);
    req.on('close', () => { clientesSSE = clientesSSE.filter(c => c !== res); });
});

app.post('/api/iniciar', async (req, res) => {
    const { pin, quantidade, intervaloEntrada, tamanhoBloco, autoPilot, delayHumano } = req.body;
    
    // Limpa sessão anterior
    botsAtivos.forEach(bot => { try { bot.client.leave(); } catch (e) {} });
    botsAtivos = [];
    perguntaAtualAvisada = false;
    fimDeJogoAvisado = false;
    stats = { botsAtivos: 0, votosEnviados: 0, perguntas: 0 };
    emitirStats();

    const delay = ms => new Promise(r => setTimeout(r, ms));
    const listaNomes = gerarNomesUnicos(quantidade);

    emitirLog(`🚀 Iniciando ${quantidade} bots...`);
    res.json({ mensagem: 'Iniciado.' });

    (async () => {
        for (let i = 0; i < quantidade; i += tamanhoBloco) {
            let promessas = [];
            
            for (let j = 0; j < tamanhoBloco; j++) {
                let index = i + j;
                if (index >= quantidade) break;

                const nome = listaNomes[index];
                const client = new Kahoot();
                const botObj = { id: index, nome: nome, client: client, pergunta: null };
                
                const p = (async () => {
                    try {
                        await delay(j * 150); // Delay para não bloquear o IP

                        await Promise.race([
                            client.join(pin, nome), 
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ao conectar')), 15000))
                        ]);
                        
                        emitirLog(`✅ ${nome} entrou.`);
                        botsAtivos.push(botObj);
                        stats.botsAtivos++;
                        emitirStats();

                        // Evento: Bot desconectado (Se cair muitos, é fim de jogo)
                        client.on('Disconnect', () => {
                            emitirLog(`⚠️ ${nome} caiu da sala.`);
                            botsAtivos = botsAtivos.filter(b => b.client !== client);
                            
                            if (botsAtivos.length < (quantidade * 0.2)) {
                                avisarFimDeJogo('Desconexão em massa');
                            }
                        });

                        // Evento: Nova pergunta
                        client.on('QuestionStart', question => {
                            botObj.pergunta = question;
                            
                            if (!perguntaAtualAvisada) {
                                perguntaAtualAvisada = true;
                                stats.perguntas++;
                                emitirStats();
                                
                                const numOpcoes = question.numberOfChoices || 4;
                                
                                if (autoPilot) {
                                    emitirLog(`🤖 AUTOPILOT: Respondendo sozinho...`);
                                    const escolha = Math.floor(Math.random() * numOpcoes);
                                    setTimeout(() => enviarVotos(escolha, delayHumano, tamanhoBloco), 500);
                                } else {
                                    emitirLog(`❓ PERGUNTA RECEBIDA! Escolha a cor no painel.`);
                                    clientesSSE.forEach(r => {
                                        try { r.write(`data: ${JSON.stringify({ tipo: 'nova_pergunta', opcoes: numOpcoes })}\n\n`); } catch (e) {}
                                    });
                                }
                            }
                        });

                        // Evento: Fim de jogo oficial (pode falhar, por isso o fallback do Disconnect)
                        client.on('QuizEnd', () => {
                            avisarFimDeJogo('Evento oficial');
                        });

                    } catch (err) {
                        const motivo = err?.message || err?.description || err?.status || 'Conexão recusada';
                        emitirLog(`❌ Falha com ${nome}: ${motivo}`);
                    }
                })();
                promessas.push(p);
            }

            await Promise.all(promessas);
            
            if (i + tamanhoBloco < quantidade) {
                emitirLog(`⏲️ Aguardando ${intervaloEntrada}ms para o próximo bloco...`);
                await delay(intervaloEntrada);
            }
        }
    })();
});

async function enviarVotos(indice, comDelay, tamanhoBloco) {
    let respondidos = 0;
    const delay = ms => new Promise(r => setTimeout(r, ms));
    let contador = 0;

    for (const botObj of botsAtivos) {
        if (botObj.pergunta) {
            try {
                if (comDelay && contador > 0 && contador % tamanhoBloco === 0) {
                    await delay(600); 
                }
                
                botObj.pergunta.answer(indice);
                respondidos++;
                stats.votosEnviados++;
                contador++;
                botObj.pergunta = null;
            } catch (e) {}
        }
    }

    if (respondidos > 0) {
        emitirLog(`🎯 Resposta enviada para ${respondidos} bots com sucesso!`);
        perguntaAtualAvisada = false;
        emitirStats();
        return { sucesso: true, respondidos };
    }
    return { sucesso: false, respondidos: 0 };
}

app.post('/api/responder', async (req, res) => {
    const { indice, delayHumano, tamanhoBloco } = req.body;
    const resultado = await enviarVotos(indice, delayHumano, tamanhoBloco);
    
    if (resultado.sucesso) {
        res.json({ mensagem: `Enviado para ${resultado.respondidos} bots!` });
    } else {
        emitirLog(`⚠️ Nenhum bot com pergunta ativa.`);
        res.status(400).json({ erro: 'Nenhum bot com pergunta ativa.' });
    }
});

app.post('/api/parar', (req, res) => {
    botsAtivos.forEach(botObj => { try { botObj.client.leave(); } catch (e) {} });
    botsAtivos = [];
    perguntaAtualAvisada = false;
    fimDeJogoAvisado = false;
    stats.botsAtivos = 0;
    emitirStats();
    emitirLog('🛑 Sala limpa. Todos os bots foram desconectados.');
    res.json({ mensagem: 'Desconectados.' });
});

app.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));