{-# LANGUAGE ForeignFunctionInterface #-}
{-# LANGUAGE ImportQualifiedPost #-}

module UplcGhcBrowser (uplcGhcBrowser) where

import Control.Monad (forM, forM_, when)
import Control.Monad.IO.Class (liftIO)
import Data.Coerce (coerce)
import Data.Char (isAlphaNum)
import Data.Dynamic (fromDynamic)
import Data.List (isPrefixOf, isSuffixOf, sort)
import Data.IORef (IORef, newIORef, readIORef, writeIORef)
import Data.Word (Word8)
import Data.ByteString qualified as ByteString
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text.Encoding
import GHC
import GHC.Driver.Backend (interpreterBackend)
import GHC.Driver.Config.Diagnostic (initDiagOpts, initPrintConfig)
import GHC.Driver.Env (hsc_plugins)
import GHC.Driver.Errors (printOrThrowDiagnostics)
import GHC.Driver.Errors.Types (GhcMessage (GhcDriverMessage))
import GHC.Driver.Monad (Session (Session), modifySession, reflectGhc)
import GHC.Driver.Plugins
  ( PluginWithArgs (PluginWithArgs)
  , Plugins (staticPlugins)
  , StaticPlugin (StaticPlugin)
  )
import GHC.Driver.Session
  ( GeneralFlag (Opt_PluginTrustworthy, Opt_WriteIfSimplifiedCore)
  , backend
  , defaultFatalMessager
  , defaultFlushOut
  , ghcLink
  , ghcMode
  , gopt_set
  , hiSuf_
  , pluginModNameOpts
  , verbosity
  )
import GHC.Runtime.Loader (initializeSessionPlugins)
import GHC.Utils.Exception (evaluate)
import GHC.Wasm.Prim
  ( JSString (JSString)
  , JSVal
  , freeJSVal
  , fromJSString
  , toJSString
  )
import Numeric (showHex)
import Plinth.Plugin qualified
import Prelude
import System.Directory
  ( createDirectoryIfMissing
  , doesFileExist
  , listDirectory
  , removeFile
  )
import System.Environment (setEnv)
import System.FilePath ((</>), replaceExtension, takeDirectory)

newtype JSFunction a = JSFunction JSVal

type CompileFunction = JSString -> JSString -> IO JSString

-- JS strings are explicitly released below. Fully force all converted input
-- first: project parsing is intentionally lazy, so evaluating only the outer
-- list constructor can otherwise leave a later module referring to freed JS
-- memory.
forceString :: String -> ()
forceString [] = ()
forceString (character : rest) = character `seq` forceString rest

forceStrings :: [String] -> ()
forceStrings [] = ()
forceStrings (value : rest) = forceString value `seq` forceStrings rest

forceProject :: [(FilePath, String)] -> ()
forceProject [] = ()
forceProject ((path, source) : rest) =
  forceString path `seq` forceString source `seq` forceProject rest

-- | Create one reusable, fully client-side uplc-ghc session. The returned
-- JavaScript async function accepts GHC flags and a NUL-delimited project.
uplcGhcBrowser :: JSString -> JSString -> IO (JSFunction CompileFunction)
uplcGhcBrowser jsLibdir jsPackagePath =
  defaultErrorHandler defaultFatalMessager defaultFlushOut $ do
    libdir <- evaluate $ fromJSString jsLibdir
    packagePath <- evaluate $ fromJSString jsPackagePath
    _ <- evaluate $ forceString libdir `seq` forceString packagePath
    freeJSVal $ coerce jsLibdir
    freeJSVal $ coerce jsPackagePath
    setEnv "GHC_PACKAGE_PATH" packagePath
    projectFiles <- newIORef []
    toCompileFunction $ \jsArgs jsProject ->
      defaultErrorHandler defaultFatalMessager defaultFlushOut $ do
        args <- evaluate $ words $ fromJSString jsArgs
        project <- evaluate $ fromJSString jsProject
        modules <- evaluate $ parseProject project
        _ <- evaluate $ forceStrings args `seq` forceProject modules
        freeJSVal $ coerce jsArgs
        freeJSVal $ coerce jsProject
        removePreviousOutputs
        writeProject projectFiles modules
        compileProjectModules
          libdir
          args
          (map ((projectRoot </>) . fst) modules)
        toJSString <$> collectOutputs

compileProjectModules :: FilePath -> [String] -> [FilePath] -> IO ()
compileProjectModules libdir args modulePaths = do
  session <- Session <$> newIORef undefined
  flip reflectGhc session $ withCleanupSession $ do
    initGhcMonad $ Just libdir
    initial <- getSessionDynFlags
    logger <- getLogger
    let packageArgs =
          [ "-dynamic"
          , "-O1"
          , "-fno-unoptimized-core-for-interpreter"
          ]
    (parsedFlags, leftovers, warnings) <-
      parseDynamicFlags logger initial $ map noLoc $ args <> packageArgs
    when (not $ null leftovers) $
      fail $ "unparsed GHC arguments: " <> show (map unLoc leftovers)
    let flags =
          parsedFlags
            { ghcMode = CompManager
            , backend = interpreterBackend
            , ghcLink = LinkInMemory
            , hiSuf_ = "dyn_hi"
            , verbosity = 1
            }
            `gopt_set` Opt_WriteIfSimplifiedCore
            `gopt_set` Opt_PluginTrustworthy
    setSessionDynFlags flags
    logger' <- getLogger
    liftIO
      $ printOrThrowDiagnostics
        logger'
        (initPrintConfig flags)
        (initDiagOpts flags)
      $ GhcDriverMessage <$> warnings
    installPlinthPlugin flags
    initializeSessionPlugins
    setTargets =<< mapM (\path -> guessTarget path Nothing Nothing) modulePaths
    result <- load LoadAllTargets
    when (failed result) $ fail "uplc-ghc load returned Failed"
    setContext [IIDecl $ simpleImportDecl $ mkModuleName "Main"]
    compiledMain <- dynCompileExpr "Main.main"
    case fromDynamic compiledMain of
      Just mainAction -> liftIO (mainAction :: IO ())
      Nothing -> fail "Main.main must have type IO ()"

projectRoot :: FilePath
projectRoot = "/tmp/plinth-project"

projectMarker :: String
projectMarker = "PLINTH_PROJECT_V1"

parseProject :: String -> [(FilePath, String)]
parseProject value =
  case splitNul value of
    marker : fields
      | marker == projectMarker ->
          case pairs fields of
            Just modules
              | not (null modules)
              , any ((== "Main.hs") . fst) modules
              , all (isSafeProjectPath . fst) modules
              , unique (map fst modules) -> modules
            _ -> error "invalid Plinth project bundle"
    _ -> [("Main.hs", value)]

splitNul :: String -> [String]
splitNul [] = [""]
splitNul value =
  let (field, rest) = break (== '\NUL') value
   in field : case rest of
        [] -> []
        _ : remaining -> splitNul remaining

pairs :: [a] -> Maybe [(a, a)]
pairs [] = Just []
pairs (left : right : rest) = ((left, right) :) <$> pairs rest
pairs _ = Nothing

unique :: Eq a => [a] -> Bool
unique [] = True
unique (item : rest) = item `notElem` rest && unique rest

isSafeProjectPath :: FilePath -> Bool
isSafeProjectPath path =
  not (null path)
    && not ("/" `isPrefixOf` path)
    && ".hs" `isSuffixOf` path
    && all validPathCharacter path
    && all validComponent (splitSlash path)
  where
    validPathCharacter character =
      isAlphaNum character || character `elem` ("_-./" :: String)
    validComponent component =
      not (null component) && component /= "." && component /= ".."

splitSlash :: String -> [String]
splitSlash [] = [""]
splitSlash value =
  let (component, rest) = break (== '/') value
   in component : case rest of
        [] -> []
        _ : remaining -> splitSlash remaining

writeProject :: IORef [FilePath] -> [(FilePath, String)] -> IO ()
writeProject projectFiles modules = do
  previousFiles <- readIORef projectFiles
  let currentFiles =
        concatMap (projectArtifacts . (projectRoot </>) . fst) modules
  forM_ (previousFiles <> currentFiles) $ \path -> do
    exists <- doesFileExist path
    when exists $ removeFile path
  createDirectoryIfMissing True projectRoot
  forM_ modules $ \(path, source) -> do
    let destination = projectRoot </> path
    createDirectoryIfMissing True $ takeDirectory destination
    ByteString.writeFile destination $ Text.Encoding.encodeUtf8 $ Text.pack source
  writeIORef projectFiles currentFiles

projectArtifacts :: FilePath -> [FilePath]
projectArtifacts path =
  [ path
  , replaceExtension path "hi"
  , replaceExtension path "dyn_hi"
  , replaceExtension path "o"
  , replaceExtension path "dyn_o"
  ]

removePreviousOutputs :: IO ()
removePreviousOutputs = do
  outputs <- filter isBrowserOutput <$> listDirectory "."
  mapM_ removeFile outputs

collectOutputs :: IO String
collectOutputs = do
  outputs <- sort . filter isBrowserOutput <$> listDirectory "."
  when (null outputs) $
    fail
      "Project produced no Flat UPLC output. Use PlutusTx.compile or call Plutarch.Browser.exportScript from Main.main."
  encoded <- forM outputs $ \output -> do
    bytes <- ByteString.readFile output
    pure $ output <> "\t" <> concatMap hexByte (ByteString.unpack bytes)
  pure $ unlines encoded

isBrowserOutput :: FilePath -> Bool
isBrowserOutput = isSuffixOf ".uplc-flat"

hexByte :: Word8 -> String
hexByte byte =
  case showHex byte "" of
    [digit] -> ['0', digit]
    digits -> digits

installPlinthPlugin :: DynFlags -> Ghc ()
installPlinthPlugin flags = do
  let pluginName = mkModuleName "Plinth.Plugin"
      pluginArgs =
        [ option
        | (name, option) <- pluginModNameOpts flags
        , name == pluginName
        ]
      plugin =
        StaticPlugin
          (PluginWithArgs Plinth.Plugin.plugin pluginArgs)
          False
  modifySession $ \environment ->
    let plugins = hsc_plugins environment
     in environment
          { hsc_plugins = plugins {staticPlugins = [plugin]}
          }

foreign import javascript "wrapper"
  toCompileFunction ::
    CompileFunction ->
    IO (JSFunction CompileFunction)

foreign export javascript "uplcGhcBrowser"
  uplcGhcBrowser ::
    JSString ->
    JSString ->
    IO (JSFunction CompileFunction)
