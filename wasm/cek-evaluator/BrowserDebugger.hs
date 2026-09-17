{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE NamedFieldPuns #-}
{-# LANGUAGE TypeApplications #-}

-- Browser adapter for the upstream machine: no reimplementation of CEK rules.
module BrowserDebugger (newDebugger) where

import CekArguments (parseArgument)
import Control.Exception (SomeException, catch, displayException)
import Control.Monad (forM, when)
import Control.Monad.Except (tryError)
import Control.Monad.Primitive (RealWorld, unsafeIOToPrim)
import Control.Monad.ST (stToIO)
import Data.Aeson
import Data.Aeson.KeyMap qualified as KeyMap
import Data.Aeson.Types (Parser, parseEither)
import Data.ByteString.Lazy qualified as BS
import Data.Foldable (toList)
import Data.Functor (void)
import Data.Functor.Identity (runIdentity)
import Data.IORef
import Data.IntMap.Strict qualified as Map
import Data.List (isPrefixOf, sortOn)
import Data.RandomAccessList.SkewBinary qualified as Env
import Data.SatInt (unSatInt)
import Data.Set qualified as Set
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import PlutusCore qualified as PLC
import PlutusCore.Annotation (SrcSpan (..), SrcSpans (..))
import PlutusCore.Builtin (BuiltinRuntime (..))
import PlutusCore.Evaluation.Machine.ExBudget
import PlutusCore.Evaluation.Machine.ExBudgetingDefaults (defaultCekParametersForTesting)
import PlutusCore.Evaluation.Machine.ExMemory (ExCPU (..), ExMemory (..))
import PlutusCore.Evaluation.Machine.MachineParameters
import PlutusCore.Flat (flat, unflat)
import PlutusCore.Pretty (displayPlc)
import UntypedPlutusCore qualified as U
import UntypedPlutusCore.Evaluation.Machine.Cek qualified as Cek
import UntypedPlutusCore.Evaluation.Machine.Cek.CekMachineCosts (CekMachineCosts, cekStartupCost)
import UntypedPlutusCore.Evaluation.Machine.SteppableCek.Internal qualified as D

-- Enrich annotations once, without changing a term or an evaluation rule.
-- Plinth propagates enclosing definition spans into descendants. A span added
-- at a child is more specific than those inherited from its parent: retain
-- both, but focus the child span when stepping (not the earlier definition).
data DebugAnn = DebugAnn
  { originalSpans :: SrcSpans
  , focusSpans :: SrcSpans
  , bindingNames :: [Text.Text]
  }

emptyAnn :: DebugAnn
emptyAnn = DebugAnn mempty mempty []

type Term = U.Term PLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun DebugAnn
type CekValue = D.CekValue PLC.DefaultUni PLC.DefaultFun DebugAnn
type Environment = D.CekValEnv PLC.DefaultUni PLC.DefaultFun DebugAnn
type State = D.CekState PLC.DefaultUni PLC.DefaultFun DebugAnn
type Context = D.Context PLC.DefaultUni PLC.DefaultFun DebugAnn
type Program = U.UnrestrictedProgram PLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun SrcSpans

data Inspectable = ValueObject CekValue | EnvObject Environment [Text.Text] | TermObject Term
type Registry = IORef (Int, Map.IntMap Inspectable)
data Session = Session
  { transition :: D.CekTrans PLC.DefaultUni PLC.DefaultFun DebugAnn RealWorld
  , budgetInfo :: D.ExBudgetInfo Cek.RestrictingSt PLC.DefaultUni PLC.DefaultFun RealWorld
  , state :: State
  , steps :: Int
  , failure :: Maybe String
  , logs :: IORef [Text.Text]
  }
-- Checkpoints hold immutable CEK graphs, budgets and persistent trace lists.
-- The live transition's mutable refs remain at the furthest executed step.
-- Revisiting history never invokes it, charges costs, or emits a trace again.
data Checkpoint = Checkpoint
  { savedState :: !State
  , savedSteps :: !Int
  , savedFailure :: Maybe String
  , savedBudget :: !ExBudget
  , savedLogs :: ![Text.Text]
  }
data Timeline = Timeline
  { machine :: Session
  , history :: Map.IntMap Checkpoint
  , cursor :: !Int
  }

-- Keep every transition in a bounded window, including transitions inside
-- Continue/Next source batches. Share the underlying immutable CEK values.
historyLimit :: Int
historyLimit = 10000

data Command = Start FilePath [String] | Advance Int Bool [(FilePath, Int)] | Back Int | Inspect Int Int | Stop

parseCommand :: Value -> Parser Command
parseCommand = withObject "debug command" $ \o -> do
  op <- o .: "op" :: Parser String
  case op of
    "start" -> Start <$> o .: "filename" <*> o .: "args"
    "step" -> Advance <$> o .:? "count" .!= 1 <*> o .:? "source" .!= False
      <*> (o .:? "breakpoints" .!= [] >>= mapM (withObject "breakpoint" $ \b -> (,) <$> b .: "file" <*> b .: "line"))
    "back" -> Back <$> o .:? "count" .!= 1
    "inspect" -> Inspect <$> o .: "epoch" <*> o .: "ref"
    "stop" -> pure Stop
    _ -> fail "Unknown debug command"

budgetLimit :: ExBudget
budgetLimit = ExBudget (ExCPU 15000000000) (ExMemory 40000000)

parameters :: MachineParameters CekMachineCosts PLC.DefaultFun CekValue
parameters = defaultCekParametersForTesting

newDebugger :: IO (String -> IO String)
newDebugger = do
  current <- newIORef Nothing
  registry <- newIORef (0, Map.empty)
  epoch <- newIORef (0 :: Int)
  pure $ \encoded -> do
    response <- (do
      request <- either fail pure $ eitherDecode (BS.fromStrict $ Text.encodeUtf8 $ Text.pack encoded) >>= parseEither parseCommand
      case request of
        Stop -> do
          writeIORef current Nothing
          writeIORef registry (0, Map.empty)
          modifyIORef' epoch (+1)
          pure $ object ["stopped" .= True]
        Inspect expected ref -> do
          actual <- readIORef epoch
          when (expected /= actual) $ fail "This value belongs to an earlier debugger state"
          (_, objects) <- readIORef registry
          maybe (fail "Unknown debugger value") (inspectObject registry) (Map.lookup ref objects)
        Start filename args -> do
          writeIORef current Nothing
          writeIORef registry (0, Map.empty)
          bytes <- BS.readFile (filename ++ ".debug")
          U.UnrestrictedProgram annotated@(U.Program _ _ term) <- either (fail . show) pure $ unflat @Program bytes
          original <- BS.readFile filename
          -- Check the sidecar is exactly this output, not a stale/reordered dump.
          when (BS.fromStrict (flat $ U.UnrestrictedProgram $ void annotated) /= original) $
            fail "Annotated program does not match the compiled Flat output"
          arguments <- either fail pure $ traverse parseArgument args
          logRef <- newIORef []
          let emitter = D.EmitterMode $ \_ -> pure $ D.CekEmitterInfo
                (\entries -> unsafeIOToPrim $ modifyIORef' logRef (reverse (toList entries) ++))
                (pure [])
          -- Like the upstream TUI emitter, this callback runs only in IO's
          -- RealWorld. The transition and its budget refs live for the session.
          (trans, budget) <- D.mkCekTrans parameters
            (Cek.restricting $ ExRestrictingBudget budgetLimit) emitter D.nilSlippage
          let prepared = prepareTerm mempty [] term
              applied = foldl (U.Apply emptyAnn) prepared (map (fmap $ const emptyAnn) arguments)
              session = Session trans budget (D.Starting applied) 0 Nothing logRef
          first <- capture session
          let timeline = Timeline session (Map.singleton 0 first) 0
          writeIORef current $ Just timeline
          snapshot epoch registry timeline
        Back requested -> do
          timeline <- readIORef current >>= maybe (fail "Start a debugger session first") pure
          let first = fst $ Map.findMin $ history timeline
              previous = timeline { cursor = max first $ cursor timeline - max 1 (min 200 requested) }
          writeIORef current $ Just previous
          snapshot epoch registry previous
        Advance requested sourceMode breakpoints -> do
          timeline <- readIORef current >>= maybe (fail "Start a debugger session first") pure
          next <- advance (max 1 $ min 200 requested) sourceMode breakpoints timeline
          writeIORef current $ Just next
          snapshot epoch registry next
      ) `catch` (\e -> pure $ object ["error" .= displayException (e :: SomeException)])
    pure $ Text.unpack $ Text.decodeUtf8 $ BS.toStrict $ encode response

capture :: Session -> IO Checkpoint
capture Session {state, steps, failure, budgetInfo, logs} =
  Checkpoint state steps failure
    <$> stToIO (D._exBudgetModeGetCumulative budgetInfo)
    <*> readIORef logs

selected :: Timeline -> Checkpoint
selected Timeline {history, cursor} = history Map.! cursor

stepMachine :: Session -> IO Session
stepMachine s = do
  result <- D.liftCek $ tryError $ do
    case state s of
      D.Starting {} -> D.unCekBudgetSpender (D._exBudgetModeSpender $ budgetInfo s) D.BStartup $
        runIdentity $ cekStartupCost $ machineCosts $ machineVariantParameters parameters
      _ -> pure ()
    transition s (state s)
  pure $ case result of
    Left err -> s { failure = Just $ show err, steps = steps s + 1 }
    Right nextState -> s { state = nextState, steps = steps s + 1 }

forward :: Timeline -> IO Timeline
forward timeline@Timeline {machine, history, cursor}
  | cursor < steps machine = pure timeline { cursor = cursor + 1 }
  | otherwise = do
      next <- stepMachine machine
      checkpoint <- capture next
      let inserted = Map.insert (steps next) checkpoint history
          retained = if steps next > historyLimit then Map.deleteMin inserted else inserted
      pure $ Timeline next retained (steps next)

advance :: Int -> Bool -> [(FilePath, Int)] -> Timeline -> IO Timeline
advance count sourceMode breakpoints initial = loop count initial
  where
    origin = sourceLocation $ savedState $ selected initial
    loop 0 s = pure s
    loop n s | isDone (selected s) = pure s
             | otherwise = do
      next <- forward s
      let nextState = savedState $ selected next
          location = sourceLocation nextState
          hit = case (nextState, location) of
            (D.Computing {}, Just span_) ->
              (sourceMode && Just span_ /= origin) ||
              any (\(file, line) -> modulePath (srcSpanFile span_) == file && srcSpanSLine span_ <= line && line <= srcSpanELine span_) breakpoints
            _ -> False
      if hit then pure next else loop (n - 1) next

isDone :: Checkpoint -> Bool
isDone Checkpoint { savedFailure = Just _ } = True
isDone Checkpoint { savedState = D.Terminating _ } = True
isDone _ = False

modulePath :: FilePath -> FilePath
modulePath file = let prefix = "/tmp/plinth-project/" in
  if prefix `isPrefixOf` file then drop (length prefix) file else file

sourceLocation :: State -> Maybe SrcSpan
sourceLocation st = case sortOn (\s -> (srcSpanELine s - srcSpanSLine s, srcSpanECol s - srcSpanSCol s, srcSpanFile s, srcSpanSLine s, srcSpanSCol s)) candidates of
    first : _ -> Just first
    [] -> Nothing
  where
    ann = maybe emptyAnn id $ stateSpans st
    project = filter (("/tmp/plinth-project/" `isPrefixOf`) . srcSpanFile) . Set.toList . unSrcSpans
    focused = project $ focusSpans ann
    candidates = if null focused then project $ originalSpans ann else focused

stateSpans :: State -> Maybe DebugAnn
stateSpans (D.Starting term) = Just $ termAnn term
stateSpans st = D.cekStateAnn st

spansJSON :: SrcSpans -> [Value]
spansJSON = map (\s -> object ["file" .= modulePath (srcSpanFile s), "startLine" .= srcSpanSLine s,
  "startColumn" .= srcSpanSCol s, "endLine" .= srcSpanELine s, "endColumn" .= srcSpanECol s]) . Set.toList . unSrcSpans

register :: Registry -> String -> Inspectable -> IO Value
register registry label value = do
  (next, items) <- readIORef registry
  writeIORef registry (next + 1, Map.insert next value items)
  pure $ object ["ref" .= next, "label" .= label, "preview" .= objectPreview value]

prepareTerm :: SrcSpans -> [Text.Text] -> U.Term PLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun SrcSpans -> Term
prepareTerm parent names term =
  let spans = termAnn term
      added = unSrcSpans spans `Set.difference` unSrcSpans parent
      -- Do not manufacture a location for generated/unannotated code.
      ann = DebugAnn spans (if Set.null added then spans else SrcSpans added) names
      child = prepareTerm spans names
  in case term of
    U.Var _ name -> U.Var ann name
    U.LamAbs _ name@(PLC.NamedDeBruijn text _) body -> U.LamAbs ann name $ prepareTerm spans (text : names) body
    U.Apply _ fun arg -> U.Apply ann (child fun) (child arg)
    U.Delay _ body -> U.Delay ann (child body)
    U.Force _ body -> U.Force ann (child body)
    U.Constant _ value -> U.Constant ann value
    U.Builtin _ fun -> U.Builtin ann fun
    U.Constr _ tag fields -> U.Constr ann tag (map child fields)
    U.Case _ scrutinee branches -> U.Case ann (child scrutinee) (fmap child branches)
    U.Error _ -> U.Error ann

snapshot :: IORef Int -> Registry -> Timeline -> IO Value
snapshot epoch registry timeline = do
  modifyIORef' epoch (+1)
  revision <- readIORef epoch
  writeIORef registry (0, Map.empty)
  let checkpoint@Checkpoint {savedState, savedSteps, savedFailure, savedBudget, savedLogs} = selected timeline
  (phase, control, environment, context, result) <- case savedState of
    D.Starting term -> do
      ref <- register registry "Program" $ TermObject term
      pure ("starting" :: String, Just ref, Nothing, D.NoFrame, Nothing)
    D.Computing ctx env term -> do
      ref <- register registry (termKind term) $ TermObject term
      envRef <- register registry "Environment (index 1 = newest binding)" $ EnvObject env (bindingNames $ termAnn term)
      pure ("computing", Just ref, Just envRef, ctx, Nothing)
    D.Returning ctx value -> do
      ref <- register registry (valueKind value) $ ValueObject value
      pure ("returning", Just ref, Nothing, ctx, Nothing)
    D.Terminating value -> pure ("terminated", Nothing, Nothing, D.NoFrame,
      Just (displayPlc $ D.dischargeResultToTerm value :: Text.Text))
  frames <- framesJSON registry context
  pure $ object ["epoch" .= revision, "step" .= savedSteps, "phase" .= (if savedFailure /= Nothing then "failed" else phase),
    "done" .= isDone checkpoint, "control" .= control, "environment" .= environment, "frames" .= frames,
    "spans" .= spansJSON (originalSpans $ maybe emptyAnn id $ stateSpans savedState),
    "focusSpans" .= spansJSON (focusSpans $ maybe emptyAnn id $ stateSpans savedState),
    "action" .= stateAction savedState, "budget" .= budgetJSON savedBudget,
    "remaining" .= budgetJSON (budgetLimit `minusExBudget` savedBudget), "logs" .= reverse savedLogs,
    "history" .= object ["first" .= fst (Map.findMin $ history timeline), "last" .= steps (machine timeline), "limit" .= historyLimit],
    "failure" .= savedFailure, "result" .= result]

budgetJSON :: ExBudget -> Value
budgetJSON (ExBudget (ExCPU cpu) (ExMemory memory)) = object ["cpu" .= show (unSatInt cpu), "memory" .= show (unSatInt memory)]

termKind :: Term -> String
termKind = \case
  U.Var _ (PLC.NamedDeBruijn name index) -> "Var " ++ Text.unpack name ++ " [" ++ show index ++ "]"
  U.LamAbs {} -> "LamAbs"
  U.Apply {} -> "Apply"
  U.Delay {} -> "Delay"
  U.Force {} -> "Force"
  U.Constant {} -> "Constant"
  U.Builtin _ fun -> "Builtin " ++ show fun
  U.Constr _ tag _ -> "Constr " ++ show tag
  U.Case {} -> "Case"
  U.Error {} -> "Error"

valueKind :: CekValue -> String
valueKind = \case
  D.VCon constant -> "Constant: " ++ Text.unpack (Text.take 100 $
    displayPlc (U.Constant () constant :: U.Term PLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun ()))
  D.VDelay {} -> "Delay closure"
  D.VLamAbs (PLC.NamedDeBruijn name _) _ _ -> "Lambda closure: " ++ Text.unpack name
  D.VBuiltin fun _ _ -> "Builtin: " ++ show fun
  D.VConstr tag _ -> "Constructor " ++ show tag

-- Bounded previews come from real UPLC, never inferred from Haskell text.
-- Full terms and closure environments remain available through inspection.
termPreview :: U.Term PLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun ann -> Text.Text
termPreview = Text.take 240 . go (5 :: Int)
  where
    go 0 _ = "…"
    go depth term = case term of
      U.Var _ (PLC.NamedDeBruijn name _) -> name
      U.Builtin _ fun -> Text.pack $ show fun
      U.Constant _ value -> Text.take 100 $ displayPlc (U.Constant () value :: U.Term PLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun ())
      U.Apply _ fun arg -> "(" <> go (depth - 1) fun <> " " <> go (depth - 1) arg <> ")"
      U.LamAbs _ (PLC.NamedDeBruijn name _) _ -> "λ " <> name <> " → …"
      U.Delay _ _ -> "delay (…)"
      U.Force _ body -> "force " <> go (depth - 1) body
      U.Constr _ tag _ -> "constructor " <> Text.pack (show tag)
      U.Case _ scrutinee _ -> "case " <> go (depth - 1) scrutinee
      U.Error _ -> "error"

valuePreview :: CekValue -> Text.Text
valuePreview = \case
  D.VCon value -> termPreview (U.Constant () value)
  D.VLamAbs (PLC.NamedDeBruijn name _) _ _ -> "λ " <> name
  D.VDelay {} -> "delay (…)"
  D.VBuiltin _ term _ -> termPreview term
  value -> Text.pack $ valueKind value

objectPreview :: Inspectable -> Text.Text
objectPreview = \case
  TermObject term -> termPreview term
  ValueObject value -> valuePreview value
  EnvObject env names -> Text.intercalate "; " $
    [ (if Text.null name then "[" <> Text.pack (show index) <> "]" else name) <> " = " <> valuePreview value
    | (index, name, value) <- take 4 $ zip3 [1 :: Int ..] (names ++ repeat "") (envValues env) ]

frameSummary :: Context -> Text.Text
frameSummary = \case
  D.FrameAwaitArg _ fun _ -> "Apply " <> valuePreview fun <> " to the returned argument"
  D.FrameAwaitFunTerm _ _ argument _ -> "Then evaluate " <> termPreview argument
  D.FrameAwaitFunConN {} -> "Apply stored constant arguments"
  D.FrameAwaitFunValueN {} -> "Apply stored value arguments"
  D.FrameForce {} -> "Force the returned value"
  D.FrameConstr _ _ tag _ _ _ -> "Finish constructor " <> Text.pack (show tag)
  D.FrameCases {} -> "Choose a branch for the returned constructor"
  D.NoFrame -> "Return the final result"

stateAction :: State -> Text.Text
stateAction = \case
  D.Starting {} -> "Start evaluation"
  D.Computing _ _ term -> case term of
    U.Var _ (PLC.NamedDeBruijn name _) -> "Read " <> name
    U.Apply _ fun _ -> "Evaluate function " <> termPreview fun
    _ -> "Evaluate " <> termPreview term
  D.Returning (D.FrameAwaitArg _ fun _) value -> "Apply " <> valuePreview fun <> " to " <> valuePreview value
  D.Returning ctx _ -> frameSummary ctx
  D.Terminating {} -> "Evaluation complete"

inspectObject :: Registry -> Inspectable -> IO Value
inspectObject registry = \case
  TermObject term -> do
    children <- forM (termChildren term) $ \(label, child) -> register registry label $ TermObject child
    pure $ object ["kind" .= termKind term, "text" .= (displayPlc (void term) :: Text.Text),
      "spans" .= spansJSON (originalSpans $ termAnn term), "focusSpans" .= spansJSON (focusSpans $ termAnn term), "children" .= children]
  EnvObject env names -> do
    children <- forM (zip3 [1 :: Int ..] (names ++ repeat "") $ envValues env) $ \(index, name, value) -> do
      ref <- register registry ("[" ++ show index ++ "] " ++ valueKind value) $ ValueObject value
      pure $ case ref of
        Object fields -> Object $ fields <> KeyMap.fromList ["name" .= name, "index" .= index]
        _ -> ref
    pure $ object ["kind" .= ("Environment" :: String), "children" .= children]
  ValueObject value -> do
    (text, children) <- case value of
      D.VCon constant -> pure (displayPlc (U.Constant () constant :: U.Term PLC.NamedDeBruijn PLC.DefaultUni PLC.DefaultFun ()), [])
      D.VDelay body env -> closure body env (bindingNames $ termAnn body)
      D.VLamAbs _ body env -> closure body env (drop 1 $ bindingNames $ termAnn body)
      D.VBuiltin _ term runtime -> pure
        (displayPlc term <> "\n" <> case runtime of
          BuiltinExpectArgument {} -> "Awaiting an argument"
          BuiltinExpectForce {} -> "Awaiting force"
          BuiltinCostedResult {} -> "Costed result", [])
      D.VConstr _ fields -> do
        refs <- forM (zip [0 :: Int ..] $ multiValues fields) $ \(i, v) -> register registry ("Field " ++ show i) $ ValueObject v
        pure ("", refs)
    pure $ object ["kind" .= valueKind value, "text" .= text, "children" .= children]
  where
    closure body env names = do
      bodyRef <- register registry "Body" $ TermObject body
      envRef <- register registry "Captured environment" $ EnvObject env names
      pure ("" :: Text.Text, [bodyRef, envRef])

termChildren :: Term -> [(String, Term)]
termChildren = \case
  U.Apply _ fun arg -> [("Function", fun), ("Argument", arg)]
  U.LamAbs _ _ body -> [("Body", body)]
  U.Delay _ body -> [("Delayed term", body)]
  U.Force _ body -> [("Forced term", body)]
  U.Constr _ _ fields -> zipWith (\i t -> ("Field " ++ show i, t)) [0 :: Int ..] fields
  U.Case _ scrutinee cases -> ("Scrutinee", scrutinee) : zipWith (\i t -> ("Branch " ++ show i, t)) [0 :: Int ..] (toList cases)
  _ -> []

termAnn :: U.Term name uni fun ann -> ann
termAnn = \case
  U.Var ann _ -> ann
  U.LamAbs ann _ _ -> ann
  U.Apply ann _ _ -> ann
  U.Delay ann _ -> ann
  U.Force ann _ -> ann
  U.Constant ann _ -> ann
  U.Builtin ann _ -> ann
  U.Constr ann _ _ -> ann
  U.Case ann _ _ -> ann
  U.Error ann -> ann

envValues :: Environment -> [CekValue]
envValues Env.Nil = []
envValues (Env.Cons value rest) = value : envValues rest
stackValues :: D.ArgStack PLC.DefaultUni PLC.DefaultFun DebugAnn -> [CekValue]
stackValues D.NilStack = []
stackValues (D.ConsStack v rest) = v : stackValues rest
nonEmptyValues :: D.ArgStackNonEmpty PLC.DefaultUni PLC.DefaultFun DebugAnn -> [CekValue]
nonEmptyValues (D.LastStackNonEmpty v) = [v]
nonEmptyValues (D.ConsStackNonEmpty v rest) = v : nonEmptyValues rest
multiValues :: D.EmptyOrMultiStack PLC.DefaultUni PLC.DefaultFun DebugAnn -> [CekValue]
multiValues D.EmptyStack = []
multiValues (D.MultiStack values) = nonEmptyValues values

framesJSON :: Registry -> Context -> IO [Value]
framesJSON _ D.NoFrame = pure []
framesJSON registry ctx = do
  (kind, ann, fields, rest) <- case ctx of
    D.FrameAwaitArg ann fun rest -> do
      ref <- val "Function value" fun
      pure ("Await argument", ann, [ref], rest)
    D.FrameAwaitFunTerm ann env argument rest -> do
      a <- term "Pending argument" argument
      e <- environment env (bindingNames $ termAnn argument)
      pure ("Await function", ann, [a,e], rest)
    D.FrameAwaitFunConN ann values rest -> do
      refs <- mapM (val "Builtin case argument" . D.VCon) $ toList values
      pure ("Await function / constant arguments", ann, refs, rest)
    D.FrameAwaitFunValueN ann values rest -> do
      refs <- mapM (val "Pending value") $ nonEmptyValues values
      pure ("Await function / value arguments", ann, refs, rest)
    D.FrameForce ann rest -> pure ("Force", ann, [], rest)
    D.FrameConstr ann env tag todo done rest -> do
      e <- environment env (bindingNames ann)
      ts <- mapM (term "Pending field") todo
      vs <- mapM (val "Evaluated field (newest first)") $ stackValues done
      pure ("Build constructor " ++ show tag, ann, e : vs ++ ts, rest)
    D.FrameCases ann env branches rest -> do
      e <- environment env (bindingNames ann)
      ts <- mapM (uncurry term) $ zipWith (\i t -> ("Branch " ++ show i,t)) [0 :: Int ..] (toList branches)
      pure ("Select case", ann, e : ts, rest)
  remaining <- framesJSON registry rest
  pure $ object ["kind" .= (kind :: String), "spans" .= spansJSON (originalSpans ann),
    "focusSpans" .= spansJSON (focusSpans ann), "summary" .= frameSummary ctx, "fields" .= fields] : remaining
  where
    val label value = register registry (label ++ " — " ++ valueKind value) (ValueObject value)
    term label = register registry label . TermObject
    environment env names = register registry "Saved environment" $ EnvObject env names
