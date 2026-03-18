import { useEffect, useState } from 'react'
import { DailyProvider } from '@daily-co/daily-react'
import { WelcomeScreen } from '@/components/WelcomeScreen'
import { DemoCallScreen } from '@/components/DemoCallScreen'
import { createConversation, endConversation } from '@/api'
import { IConversation } from '@/types'
import { useToast } from "@/hooks/use-toast"

function App() {
  const { toast } = useToast()
  const [screen, setScreen] = useState<'welcome' | 'call'>('welcome')
  const [conversation, setConversation] = useState<IConversation | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    return () => {
      if (conversation) {
        void endConversation(conversation.conversation_id)
      }
    }
  }, [conversation])

  const handleStart = async () => {
    try {
      setLoading(true)
      const conv = await createConversation()
      setConversation(conv)
      setScreen('call')
    } catch {
      toast({
        variant: "destructive",
        title: "Uh oh! Something went wrong.",
        description: 'Check console for details',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleEnd = async () => {
    try {
      if (!conversation) return
      await endConversation(conversation.conversation_id)
    } catch (error) {
      console.error(error)
    } finally {
      setConversation(null)
      setScreen('welcome')
    }
  }

  return (
    <DailyProvider>
      {screen === 'welcome' && <WelcomeScreen onStart={handleStart} loading={loading} />}
      {screen === 'call' && conversation && (
        <DemoCallScreen conversation={conversation} onEnd={handleEnd} />
      )}
    </DailyProvider>
  )
}

export default App
